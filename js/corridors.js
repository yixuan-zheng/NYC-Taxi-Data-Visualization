// ===== Corridor search + filter UI =====

// DOM refs for corridor search + controls
let corridorOriginInput;
let corridorDestInput;
let corridorOriginList;
let corridorDestList;
let corridorGoBtn;

let odCorridorControls;
let corridorBtn;
let corridorFilterEl;
let odSummary;

// Search index state
let zoneNameToId = new Map();
let corridorOriginOptions = [];
let corridorDestOptionsByOrigin = new Map();   // origin label -> Set of dest labels
let corridorOriginOptionsByDest = new Map();   // dest label   -> Set of origin labels
let aliasToBoroughs = new Map();

/**
 * Make a direction-agnostic key from a corridor label.
 * "Midtown ↔ LaGuardia" and "LaGuardia ↔ Midtown" → same key.
 */
function canonicalCorridorKeyFromLabel(label) {
  if (!label) return null;
  const parts = label.split("↔");
  if (parts.length !== 2) {
    // If it doesn't follow "A ↔ B", just normalize whitespace.
    return label.trim();
  }
  const left = parts[0].trim();
  const right = parts[1].trim();
  const sorted = [left, right].sort((a, b) => a.localeCompare(b));
  return `${sorted[0]} ↔ ${sorted[1]}`;
}

/**
 * Try to infer a concrete taxi zone id from a corridor alias like "Midtown" or "JFK".
 * Case-insensitive, fuzzy "contains" match on zone names.
 */
function guessZoneIdForAlias(label) {
  if (!label) return null;
  const q = label.toLowerCase();
  let bestId = null;

  idTo.forEach((info, id) => {
    const name = (info.zone || "").toLowerCase();
    if (!name) return;
    if (name.includes(q)) {
      bestId = id;
    }
  });

  return bestId;
}

/**
 * Build the search index used by the corridor origin/destination inputs:
 * - zoneNameToId: for snapping aliases to concrete zones
 * - corridorOriginOptions: list of endpoint aliases from semantics
 * - corridorDestOptionsByOrigin / corridorOriginOptionsByDest: adjacency
 * - aliasToBoroughs: map alias → borough set (Manhattan, Queens, …)
 */
function buildCorridorSearchIndex() {
  // 1) Zone name → id (for snapping primary to a zone later)
  zoneNameToId = new Map();
  idTo.forEach((info, id) => {
    const name = (info.zone || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!zoneNameToId.has(key)) {
      zoneNameToId.set(key, id);
    }
  });

  // 2) Corridor endpoints from semantics (labels like "Midtown ↔ JFK")
  const endpointPairs = [];
  if (semantics) {
    Object.keys(semantics).forEach(k => {
      const info = semantics[k];
      if (!info || !info.label) return;
      const label = info.label;
      const parts = label.split("↔");
      if (parts.length !== 2) return;
      const left = parts[0].trim();
      const right = parts[1].trim();
      if (!left || !right) return;
      endpointPairs.push([left, right]);
    });
  }

  const endpointSet = new Set();
  endpointPairs.forEach(([a, b]) => {
    endpointSet.add(a);
    endpointSet.add(b);
  });

  // 3) For each endpoint, which other endpoints does it connect to?
  //    Used for:
  //    - destination suggestions when origin is picked (origin -> dest)
  //    - origin suggestions when destination is picked (dest -> origin)
  corridorDestOptionsByOrigin = new Map();
  corridorOriginOptionsByDest = new Map();

  endpointPairs.forEach(([a, b]) => {
    // origin -> dest map
    if (!corridorDestOptionsByOrigin.has(a)) corridorDestOptionsByOrigin.set(a, new Set());
    if (!corridorDestOptionsByOrigin.has(b)) corridorDestOptionsByOrigin.set(b, new Set());
    corridorDestOptionsByOrigin.get(a).add(b);
    corridorDestOptionsByOrigin.get(b).add(a);

    // dest -> origin map (symmetric in this undirected world)
    if (!corridorOriginOptionsByDest.has(a)) corridorOriginOptionsByDest.set(a, new Set());
    if (!corridorOriginOptionsByDest.has(b)) corridorOriginOptionsByDest.set(b, new Set());
    corridorOriginOptionsByDest.get(a).add(b);
    corridorOriginOptionsByDest.get(b).add(a);
  });

  // 4) Origin suggestions: **aliases only** (no borough names, no raw zone names).
  corridorOriginOptions = Array.from(endpointSet);

  // 5) Build alias → boroughs map using cluster_semantics.json.
  //    We use from_area/to_area and from_borough_area/to_borough_area so
  //    aliases like "Midtown", "Upper East Side", "Chelsea" can be linked
  //    to "Manhattan", "Queens", etc.
  aliasToBoroughs = new Map();

  // helper to normalize borough text like "Manhattan area" -> "Manhattan"
  function cleanBoroughName(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    // drop trailing "area" if present
    s = s.replace(/ area$/i, "").trim();
    return s;
  }

  if (semantics) {
    Object.values(semantics).forEach(info => {
      if (!info) return;

      const fromArea = info.from_area && info.from_area.trim();
      const toArea   = info.to_area && info.to_area.trim();
      const fromBoro = cleanBoroughName(info.from_borough_area);
      const toBoro   = cleanBoroughName(info.to_borough_area);

      [[fromArea, fromBoro], [toArea, toBoro]].forEach(([area, boro]) => {
        if (!area || !boro) return;

        // only care about endpoints that we actually use as aliases
        if (!corridorOriginOptions.includes(area)) return;

        if (!aliasToBoroughs.has(area)) {
          aliasToBoroughs.set(area, new Set());
        }
        aliasToBoroughs.get(area).add(boro);
      });
    });
  }

  // Optional fallback: if some aliases still have no boroughs, try to infer
  // from zone names.
  corridorOriginOptions.forEach(alias => {
    if (aliasToBoroughs.has(alias)) return;   // already has borough info

    const aliasLower = alias.toLowerCase();
    idTo.forEach(info => {
      const zoneName = (info.zone || "").toLowerCase();
      const borough = info.borough;
      if (!zoneName || !borough) return;

      if (zoneName.includes(aliasLower) || aliasLower.includes(zoneName)) {
        if (!aliasToBoroughs.has(alias)) {
          aliasToBoroughs.set(alias, new Set());
        }
        aliasToBoroughs.get(alias).add(borough);
      }
    });
  });

  // IMPORTANT:
  // We do NOT pre-populate corridorOriginList here anymore.
  // The datalist will be filled dynamically on `input` (type-to-search),
  // so the field no longer behaves like a giant dropdown.
  if (corridorOriginList) {
    corridorOriginList.innerHTML = "";
  }
}

/**
 * Given user input that looks like a borough ("manhattan", "queens", etc.),
 * return all corridor aliases whose underlying zones belong to that borough.
 */
function getAliasesForBoroughSearch(input) {
  if (!input) return [];
  const q = input.toLowerCase();

  const result = [];

  aliasToBoroughs.forEach((boroughSet, alias) => {
    for (const borough of boroughSet) {
      const bLower = String(borough).toLowerCase();
      // case-insensitive partial match:
      // "manh", "MANHATTAN", "Manhattan, NY" all work
      if (bLower.includes(q) || q.includes(bLower)) {
        result.push(alias);
        break; // go to next alias once this one matched
      }
    }
  });

  return result;
}

/**
 * Update the destination datalist based on the chosen origin label.
 */
function updateCorridorDestSuggestions(originLabel) {
  if (!corridorDestList) return;

  const o = originLabel.trim();
  if (!o) {
    corridorDestList.innerHTML = "";
    return;
  }

  const destSet = new Set();

  // 1) Direct pairs from semantics (exact endpoint match)
  const direct = corridorDestOptionsByOrigin.get(o);
  if (direct) {
    direct.forEach(v => destSet.add(v));
  }

  // 2) If origin is a borough, include endpoints from corridors that mention that borough
  const lowerOrigin = o.toLowerCase();
  if (semantics) {
    Object.values(semantics).forEach(info => {
      if (!info || !info.label) return;
      const label = info.label.toLowerCase();
      if (!label.includes(lowerOrigin)) return;
      const parts = info.label.split("↔");
      if (parts.length !== 2) return;
      const left = parts[0].trim();
      const right = parts[1].trim();
      if (left.toLowerCase() !== lowerOrigin) destSet.add(left);
      if (right.toLowerCase() !== lowerOrigin) destSet.add(right);
    });
  }

  const options = Array.from(destSet).sort((a, b) => a.localeCompare(b));
  corridorDestList.innerHTML = options
    .map(lbl => `<option value="${lbl}"></option>`)
    .join("");
}

/**
 * Update the origin datalist based on a chosen destination label.
 */
function updateCorridorOriginSuggestions(destLabel) {
  if (!corridorOriginList) return;

  const d = destLabel.trim();
  if (!d) {
    corridorOriginList.innerHTML = "";
    return;
  }

  const originSet = corridorOriginOptionsByDest.get(d);
  if (!originSet || originSet.size === 0) {
    corridorOriginList.innerHTML = "";
    return;
  }

  const options = Array.from(originSet)
    .sort((a, b) => a.localeCompare(b));

  corridorOriginList.innerHTML = options
    .map(lbl => {
      const bSet = aliasToBoroughs.get(lbl);
      let hint = "";
      if (bSet && bSet.size > 0) {
        const boroughLabel = Array.from(bSet).join(" / ");
        hint = ` (${boroughLabel})`;
      }
      return `<option value="${lbl}">${lbl}${hint}</option>`;
    })
    .join("");
}

/**
 * Wire all corridor-related DOM event listeners.
 */
function bindCorridorEvents() {
  // Old button (now basically unused, but we keep behavior 1:1)
  if (corridorBtn) {
    corridorBtn.addEventListener("click", () => {
      if (!selectedPrimary) return;
      corridorMode = !corridorMode;
      corridorBtn.textContent = corridorMode
        ? "Hide corridor highlight"
        : "Show corridor routes";
      renderODForPrimary();
    });
  }

  // Corridor filter dropdown (under the OD summary)
  if (corridorFilterEl) {
    corridorFilterEl.addEventListener("change", () => {
      const v = corridorFilterEl.value;

      if (v === "__all__") {
        // Highlight all corridor routes for this zone
        corridorMode = true;
        activeCorridorId = null;
      } else {
        // Highlight only the selected corridor (canonical key)
        corridorMode = true;
        activeCorridorId = v;
      }

      // When changing corridor filter, drop any previously selected route
      // so the user sees all flows for the new corridor.

    selectedSecondary = null;

    if (selectedPrimary) {
      renderODForPrimary();
    } else if (typeof renderCorridorOverview === "function") {
      // No single primary selected → show many-to-many corridor view
      const keyToUse = (v === "__all__") ? activeCorridorId : v;
      if (keyToUse) {
        renderCorridorOverview(keyToUse);
      }
    }
    });
  }

  // Origin input: type-to-search
  if (corridorOriginInput && corridorOriginList) {
    corridorOriginInput.addEventListener("input", () => {
      const raw = corridorOriginInput.value.trim();
      const q = raw.toLowerCase();

      // Empty input: clear suggestions so the field doesn't act like a giant dropdown
      if (!q) {
        corridorOriginList.innerHTML = "";
        return;
      }

      // 1) Normal alias matches from endpointSet (corridorOriginOptions)
      let suggestions = corridorOriginOptions.filter(lbl =>
        lbl.toLowerCase().includes(q)
      );

      // 2) Borough-driven aliases (e.g. input "Manhattan" → aliases in Manhattan)
      const boroughAliases = getAliasesForBoroughSearch(raw);
      suggestions = suggestions.concat(boroughAliases);

      // 3) Dedupe, sort, and limit to a manageable count
      const unique = Array.from(new Set(suggestions))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 12);

      corridorOriginList.innerHTML = unique
        .map(lbl => {
          const bSet = aliasToBoroughs.get(lbl);
          let hint = "";
          if (bSet && bSet.size > 0) {
            const boroughLabel = Array.from(bSet).join(" / ");
            hint = ` (${boroughLabel})`;
          }
          return `<option value="${lbl}">${lbl}${hint}</option>`;
        })
        .join("");
    });
  }

  // Destination input: type-to-search
  if (corridorDestInput && corridorDestList) {
    corridorDestInput.addEventListener("input", () => {
      const raw = corridorDestInput.value.trim();
      const q = raw.toLowerCase();

      // Empty input: clear suggestions so the field doesn't act like a giant dropdown
      if (!q) {
        corridorDestList.innerHTML = "";
        return;
      }

      const originLabel = corridorOriginInput ? corridorOriginInput.value.trim() : "";
      let suggestions = [];

      if (originLabel) {
        // If an origin is chosen, restrict destination to valid corridor partners
        const allowed = corridorDestOptionsByOrigin.get(originLabel) || new Set();
        suggestions = Array.from(allowed).filter(lbl =>
          lbl.toLowerCase().includes(q)
        );
      } else {
        // No origin: behave like origin search (aliases + borough search)
        suggestions = corridorOriginOptions.filter(lbl =>
          lbl.toLowerCase().includes(q)
        );

        const boroughAliases = getAliasesForBoroughSearch(raw);
        suggestions = suggestions.concat(boroughAliases);
      }

      // Dedupe, sort, and limit
      const unique = Array.from(new Set(suggestions))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 12);

      corridorDestList.innerHTML = unique
        .map(lbl => {
          const bSet = aliasToBoroughs.get(lbl);
          let hint = "";
          if (bSet && bSet.size > 0) {
            const boroughLabel = Array.from(bSet).join(" / ");
            hint = ` (${boroughLabel})`;
          }
          // value is plain alias; text shows alias + borough
          return `<option value="${lbl}">${lbl}${hint}</option>`;
        })
        .join("");
    });
  }

  // Origin input: when committed, just update destination suggestions.
  // We NO LONGER auto-snap to a primary zone here; corridor search is
  // driven by "Show routes" after both endpoints are chosen.
  if (corridorOriginInput) {
    corridorOriginInput.addEventListener("change", () => {
      const label = corridorOriginInput.value.trim();
      if (!label) return;

      // Only update destination suggestions based on this origin label.
      updateCorridorDestSuggestions(label);
    });
  }

  // Destination input: update origin suggestions or set corridor filter
  if (corridorDestInput) {
    corridorDestInput.addEventListener("change", () => {
      const oLabel = corridorOriginInput ? corridorOriginInput.value.trim() : "";
      const dLabel = corridorDestInput.value.trim();

      // If destination is chosen first and origin is empty,
      // drive origin suggestions based on this destination instead of doing nothing.
      if (!oLabel && dLabel) {
        updateCorridorOriginSuggestions(dLabel);
        return;
      }

      if (!oLabel || !dLabel) return;

      const rawLabel = `${oLabel} ↔ ${dLabel}`;
      const key = canonicalCorridorKeyFromLabel(rawLabel);
      if (!key) return;

      // Just remember the corridor; do NOT switch into corridorMode yet.
      activeCorridorId = key;
      selectedSecondary = null;

      if (selectedPrimary != null) {
        // If we already have a primary, keep the normal per-zone OD view.
        renderODForPrimary();
      } else {
        // No primary yet: wait for the "Show routes" button.
        odSummary.textContent =
          `Corridor selected: ${key}. Click "Show routes" to view flows at ${fmtHour(+hourEl.value)}.`;
      }
    });
  }

  // "Show routes" button
  if (corridorGoBtn) {
    corridorGoBtn.addEventListener("click", () => {
      const oLabel = corridorOriginInput ? corridorOriginInput.value.trim() : "";
      const dLabel = corridorDestInput ? corridorDestInput.value.trim() : "";

      // Require both endpoints to be set
      if (!oLabel || !dLabel) {
        odSummary.textContent = "Pick both a corridor origin and destination first.";
        return;
      }

      const rawLabel = `${oLabel} ↔ ${dLabel}`;
      const key = canonicalCorridorKeyFromLabel(rawLabel);
      if (!key) return;

      // 🔹 Highest priority: reset the whole view to default (all boroughs).
      // 1) Force borough filter back to "__all__"
      const boroFilterEl = document.getElementById("boroughFilter");
      if (boroFilterEl) {
        boroFilterEl.value = "__all__";
      }

      // 2) Use the shared reset helper if available. This will:
      //    - clear selectedPrimary / selectedSecondary
      //    - reset corridorMode / activeCorridorId
      //    - re-apply borough filter & zoom (now "__all__")
      if (typeof window.clearSelectionAndReset === "function") {
        window.clearSelectionAndReset();
      }

      // Now we are in a clean, city-wide view (no primary selected).
      // Turn on corridor highlighting for this corridor key.
      corridorMode       = true;
      activeCorridorId   = key;
      selectedSecondary  = null;

      // Because we just reset, selectedPrimary should be null,
      // so we go to the many-to-many corridor overview by default.
      if (typeof renderCorridorOverview === "function") {
        renderCorridorOverview(key);
        return;
      }

      // Fallback: old behavior (try to guess a single anchor zone)
      let primaryId = guessZoneIdForAlias(oLabel) ?? guessZoneIdForAlias(dLabel);

      if (primaryId != null) {
        selectedPrimary = primaryId;
        renderODForPrimary();
      } else {
        odSummary.textContent =
          `Corridor selected: ${key}. Click a zone to see trips in this corridor at ${fmtHour(+hourEl.value)}.`;
      }
    });
  }
}

/**
 * Public entry point.
 * Call this AFTER data is loaded and idTo + semantics are ready.
 */
function initCorridors() {
  // Grab DOM references
  corridorOriginInput = document.getElementById("corridorOrigin");
  corridorDestInput   = document.getElementById("corridorDest");
  corridorOriginList  = document.getElementById("corridorOriginList");
  corridorDestList    = document.getElementById("corridorDestList");
  corridorGoBtn       = document.getElementById("corridorGoBtn");

  odCorridorControls  = document.getElementById("odCorridorControls");
  corridorBtn         = document.getElementById("corridorBtn");
  corridorFilterEl    = document.getElementById("corridorFilter");
  odSummary           = document.getElementById("odSummary");

  // Build semantic index + wire events
  buildCorridorSearchIndex();
  bindCorridorEvents();
}

// Expose corridor helpers so odmap.js / wiring.js can use them
window.initCorridors = initCorridors;  

window.canonicalCorridorKeyFromLabel = canonicalCorridorKeyFromLabel;
window.guessZoneIdForAlias = guessZoneIdForAlias;

window.buildCorridorSearchIndex = buildCorridorSearchIndex;
window.getAliasesForBoroughSearch = getAliasesForBoroughSearch;
window.updateCorridorDestSuggestions = updateCorridorDestSuggestions;
window.updateCorridorOriginSuggestions = updateCorridorOriginSuggestions;