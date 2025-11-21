// odmap.js
// OD (Origin–Destination) map: right panel flows + nodes

// ----- Borough highlight colors for OD map -----
const BOROUGH_HIGHLIGHT = {
  "Manhattan":      "rgba(81, 169, 81, 0.30)",
  "Brooklyn":       "rgba(81, 169, 81, 0.30)",
  "Queens":         "rgba(81, 169, 81, 0.30)",
  "The Bronx":      "rgba(81, 169, 81, 0.30)",
  "Staten Island":  "rgba(81, 169, 81, 0.30)",
  "Unknown":        "rgba(81, 169, 81, 0.20)"
};

const BOROUGH_KEYS = [
  "manhattan",
  "brooklyn",
  "queens",
  "the bronx",
  "staten island"
];

// We’ll fill these in initODMap
let odZonePaths;
let odZonePoints;
let odNodesSel;
let odZoom;

// Shared OD state (stays as in your original code)
let selectedPrimary   = null;
let selectedSecondary = null;
let currentHoverId    = null;
let isAutoZooming     = false;

// Corridor state (per selected zone + hour)
let corridorMode            = false;
let activeCorridorId        = null;
let availableCorridors      = [];
let corridorKeyToClusterIds = new Map();
let lastCorridorOverviewKey = null;
let corridorOverviewZoneIds = null;

/**
 * Initialize OD map once data + DOM scaffolding are ready.
 * Called from wiring.js AFTER window.zones / window.flows / etc are set.
 */
function initODMap() {
  // --- Pull data + shared objects from window ---

  const zones      = window.zones;
  const flows      = window.flows;
  const idTo       = window.idTo;              // built in state.js
  const semantics  = window.semantics || {};

  const hotSvg     = window.hotSvg;
  const odSvg      = window.odSvg;
  const hotPath    = window.hotPath;
  const odPath     = window.odPath;
  const hotWidth   = window.hotWidth;
  const hotHeight  = window.hotHeight;
  const odWidth    = window.odWidth;
  const odHeight   = window.odHeight;

  const hotZonePaths       = window.hotZonePaths;
  const odZonesG           = window.odZonesG;
  const odNodesG           = window.odNodesG;
  const odEdgesG           = window.odEdgesG;
  const odRoot             = window.odRoot;

  // Tooltips / summary / debug elements
  const odTip         = d3.select("#odTip");
  const odSummary     = d3.select("#odSummary");
  const odDbg         = d3.select("#odDbg");
  const odLegendNote  = d3.select("#odLegendNote");

  // Borough filter (DOM element)
  const boroFilterEl  = document.getElementById("boroughFilter");

  // Corridor controls (DOM elements)
  const odCorridorControls = document.getElementById("odCorridorControls");
  const corridorBtn        = document.getElementById("corridorBtn");
  const corridorFilterEl   = document.getElementById("corridorFilter");

  const hourEl             = window.hourEl;
  const fmtHour            = window.fmtHour || (h => h.toString().padStart(2, "0") + ":00");

  // --- Helper: zone → borough via idTo ---
  function getZoneBoroughById(id) {
    const info = idTo.get(id);
    return info ? info.borough : "Unknown";
  }
  // Expose so hotmap.js can use it too
  window.getZoneBoroughById = getZoneBoroughById;

  // ----- OD base map polygons (right panel) -----
  odZonePaths = odZonesG.selectAll("path.od-zone")
    .data(zones.features)
    .join("path")
    .attr("class", "od-zone")
    .attr("d", odPath)
    .attr("fill", "#ffffff")
    .attr("stroke", "rgba(152,163,179,.7)")
    .attr("stroke-width", 0.7);

  // ----- OD centroids (used for nodes + edge routing) -----
  odZonePoints = zones.features.map(f => {
    const id = +f.properties.LocationID;
    const c = odPath.centroid(f);
    const lk = idTo.get(id) || { zone: "Unknown", borough: "Unknown" };
    return {
      id,
      x: c[0],
      y: c[1],
      zone: lk.zone,
      borough: lk.borough
    };
  });

  // ----- Flows cleanup -----
  flows.forEach(d => {
    d.origin_zone      = +d.origin_zone;
    d.destination_zone = +d.destination_zone;
    d.time_bin         = +d.time_bin;
    d.trip_count       = +d.trip_count;

    // normalize cluster id if present (from flows_enhanced)
    if (
      d.flow_cluster_id === undefined ||
      d.flow_cluster_id === null ||
      d.flow_cluster_id === "" ||
      +d.flow_cluster_id < 0
    ) {
      d.flow_cluster_id = null;   // treat -1 / missing as "no cluster"
    } else {
      d.flow_cluster_id = +d.flow_cluster_id;
    }
  });

  // ----- Precompute connectivity caps for OD -----
  const connMap = new Map();
  flows.forEach(row => {
    const o = row.origin_zone;
    const d = row.destination_zone;
    if (!connMap.has(o)) connMap.set(o, new Set());
    if (!connMap.has(d)) connMap.set(d, new Set());
    connMap.get(o).add(d);
    connMap.get(d).add(o);
  });

  const connectivityArray = Array.from(idTo.keys()).map(id => {
    const set = connMap.get(id);
    return { id, degree: set ? set.size : 0 };
  }).sort((a, b) => d3.descending(a.degree, b.degree));

  const nZones = connectivityArray.length;
  const top5   = Math.ceil(nZones * 0.05);
  const top10  = Math.ceil(nZones * 0.10);
  const top20  = Math.ceil(nZones * 0.20);
  const top40  = Math.ceil(nZones * 0.40);
  const zoneCapMap = new Map();

  connectivityArray.forEach((entry, idx) => {
    let cap = 20;
    if (idx < top5)       cap = 50;
    else if (idx < top10) cap = 40;
    else if (idx < top20) cap = 30;
    else if (idx < top40) cap = 20;
    zoneCapMap.set(entry.id, cap);
  });

  // Track which primaries we've already auto-zoomed for
  const autoZoomedPrimaries = new Set();

  // ----- Zoom to a borough (both panels) -----
  function zoomToBorough(b) {
    // reset to full city view
    if (!b || b === "__all__") {
      const reset = d3.zoomIdentity;
      isAutoZooming = true;

      hotSvg
        .interrupt()
        .transition()
        .duration(400)
        .ease(d3.easeCubicInOut)
        .call(window.hotZoom.transform, reset)
        .on("end", () => { isAutoZooming = false; })
        .on("interrupt", () => { isAutoZooming = false; });

      odSvg
        .interrupt()
        .transition()
        .duration(400)
        .ease(d3.easeCubicInOut)
        .call(odZoom.transform, reset)
        .on("end", () => { isAutoZooming = false; })
        .on("interrupt", () => { isAutoZooming = false; });

      return;
    }

    const features = zones.features.filter(f =>
      getZoneBoroughById(+f.properties.LocationID) === b
    );
    if (!features.length) return;

    // ----- LEFT PANEL (hotspot map) -----
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    features.forEach(f => {
      const bnd = hotPath.bounds(f);
      if (!bnd) return;
      if (bnd[0][0] < x0) x0 = bnd[0][0];
      if (bnd[0][1] < y0) y0 = bnd[0][1];
      if (bnd[1][0] > x1) x1 = bnd[1][0];
      if (bnd[1][1] > y1) y1 = bnd[1][1];
    });
    if (!isFinite(x0)) return;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const scaleHot = Math.max(
      1,
      Math.min(6, 0.9 / Math.max(dx / hotWidth, dy / hotHeight))
    );
    const txHot = hotWidth / 2 - scaleHot * cx;
    const tyHot = hotHeight / 2 - scaleHot * cy;
    const tHot = d3.zoomIdentity.translate(txHot, tyHot).scale(scaleHot);

    isAutoZooming = true;
    hotSvg
      .interrupt()
      .transition()
      .duration(400)
      .ease(d3.easeCubicInOut)
      .call(window.hotZoom.transform, tHot)
      .on("end", () => { isAutoZooming = false; })
      .on("interrupt", () => { isAutoZooming = false; });

    // ----- RIGHT PANEL (OD map) -----
    let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
    features.forEach(f => {
      const bnd = odPath.bounds(f);
      if (!bnd) return;
      if (bnd[0][0] < ox0) ox0 = bnd[0][0];
      if (bnd[0][1] < oy0) oy0 = bnd[0][1];
      if (bnd[1][0] > ox1) ox1 = bnd[1][0];
      if (bnd[1][1] > oy1) oy1 = bnd[1][1];
    });
    if (!isFinite(ox0)) return;

    const odDx = ox1 - ox0;
    const odDy = oy1 - oy0;
    const odCx = (ox0 + ox1) / 2;
    const odCy = (oy0 + oy1) / 2;
    const scaleOd = Math.max(
      1,
      Math.min(6, 0.9 / Math.max(odDx / odWidth, odDy / odHeight))
    );

    const txOd = odWidth / 2 - scaleOd * odCx;
    const tyOd = odHeight / 2 - scaleOd * odCy;
    const tOd = d3.zoomIdentity.translate(txOd, tyOd).scale(scaleOd);

    isAutoZooming = true;
    odSvg
      .interrupt()
      .transition()
      .duration(400)
      .ease(d3.easeCubicInOut)
      .call(odZoom.transform, tOd)
      .on("end", () => { isAutoZooming = false; })
      .on("interrupt", () => { isAutoZooming = false; });
  }

  // Zoom to a single zone on the left hotspot map
  function zoomToZone(zoneId) {
    const feature = zones.features.find(f => +f.properties.LocationID === zoneId);
    if (!feature) return;

    const b = hotPath.bounds(feature);
    if (!b) return;

    const x0 = b[0][0], y0 = b[0][1];
    const x1 = b[1][0], y1 = b[1][1];

    const dx = x1 - x0;
    const dy = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    const scale = Math.max(
      1,
      Math.min(6, 0.9 / Math.max(dx / hotWidth, dy / hotHeight))
    );

    const tx = hotWidth / 2 - scale * cx;
    const ty = hotHeight / 2 - scale * cy;

    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);

    hotSvg
      .interrupt()
      .transition()
      .duration(450)
      .ease(d3.easeCubicInOut)
      .call(window.hotZoom.transform, t);
  }

  // Clear selection + reset corridor + reset zoom to current borough
  function clearSelectionAndReset() {
    selectedPrimary   = null;
    selectedSecondary = null;

    corridorMode       = false;
    activeCorridorId   = null;
    availableCorridors = [];
    lastCorridorOverviewKey = null;
    corridorOverviewZoneIds = null;
    odCorridorControls.style.display = "none";
    corridorBtn.style.display        = "none";
    corridorFilterEl.style.display   = "none";
    corridorFilterEl.innerHTML       = "";

    odEdgesG.selectAll("*").remove();

    odNodesSel
      .classed("selected", false)
      .attr("opacity", 1)
      .attr("pointer-events", "auto");

    odSummary.text("No zone selected. Click a dot.");
    odDbg.text("");
    odLegendNote.text("Scaled to selected zone & hour.");

    applyBoroughFilter();
    const b = boroFilterEl.value;
    zoomToBorough(b);

    // After a full reset, allow zones to auto-zoom again when re-selected.
    autoZoomedPrimaries.clear();
  }

  // ----- OD nodes (right panel dots) -----
  odNodesSel = odNodesG.selectAll("circle.od-node")
    .data(odZonePoints)
    .join("circle")
    .attr("class", "od-node")
    .attr("r", 4)
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 1.5)
    .on("mouseenter", (event, d) => {
      if (isAutoZooming) return;

      // In corridor overview (no primary, corridorMode on, corridor selected),
      // do NOT call highlightBoth, because that would bring back all nodes.
      const inCorridorOverview =
        corridorMode && selectedPrimary === null && !!activeCorridorId;

      if (!inCorridorOverview && window.highlightBoth) {
        window.highlightBoth(d.id);
      }

      odTip.style("opacity", 1)
        .style("left", (event.offsetX + 10) + "px")
        .style("top",  (event.offsetY + 10) + "px")
        .html(`<b>${d.zone} - ${d.borough}</b>`);
    })
    .on("mouseleave", () => {
      if (isAutoZooming) return;

      odTip.style("opacity", 0);
      currentHoverId = null;

      const inCorridorOverview =
        corridorMode && selectedPrimary === null && !!activeCorridorId;

      if (!inCorridorOverview && window.restoreViews) {
        window.restoreViews();
      }
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      if (isAutoZooming) return;

      if (selectedPrimary === null) {
        selectedPrimary   = d.id;
        selectedSecondary = null;
        renderODForPrimary();
        return;
      }
      if (selectedPrimary !== null && selectedSecondary === null) {
        selectedSecondary = d.id;
        renderODForPrimary();
        return;
      }
      selectedPrimary   = d.id;
      selectedSecondary = null;
      renderODForPrimary();
    });

  // OD zoom
  odZoom = d3.zoom()
    .scaleExtent([1, 6])
    .on("zoom", (e) => {
      odRoot.attr("transform", e.transform);
      const k  = e.transform.k;
      const r  = 4 / Math.sqrt(k);
      const sw = 1 / Math.sqrt(k);

      odNodesSel
        .attr("r", r)
        .style("stroke-width", sw);
    });

  odSvg.call(odZoom);

  // Click in empty space on OD map:
  // - If we're in a per-zone corridor view that came from an overview,
  //   go back to the corridor overview.
  // - Otherwise, fully reset.
  odSvg.on("click", () => {
    const inPerZoneCorridorView =
      selectedPrimary !== null &&
      corridorMode &&
      !!activeCorridorId &&
      lastCorridorOverviewKey === activeCorridorId;

    const inCorridorOverview =
      selectedPrimary === null &&
      corridorMode &&
      !!activeCorridorId;

    if (inPerZoneCorridorView && lastCorridorOverviewKey) {
      // First click: go back to corridor overview (e.g., JFK ↔ Midtown),
      // but keep corridor selection active.
      selectedPrimary   = null;
      selectedSecondary = null;
      renderCorridorOverview(lastCorridorOverviewKey);
      return;
    }

    // If we're already in overview (or not in a corridor context),
    // a click in empty space behaves like before: full reset.
    clearSelectionAndReset();
  });

  // Borough filter — also exits lock-in view and auto-zooms
  boroFilterEl.addEventListener("change", () => {
    clearSelectionAndReset();
  });

  // ----- Borough filter logic for both maps -----
  function applyBoroughFilter() {
    const b = boroFilterEl.value;

    // OD polygons
    odZonePaths
      .attr("fill", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        if (b === "__all__") return "#ffffff";
        return (bd === b)
          ? (BOROUGH_HIGHLIGHT[bd] || BOROUGH_HIGHLIGHT["Unknown"])
          : "#ffffff";
      })
      .attr("stroke", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        if (b === "__all__") {
          return "rgba(152,163,179,.7)";
        }
        return (bd === b) ? "#7e22ce" : "rgba(152,163,184,.4)";
      })
      .attr("stroke-width", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        if (b === "__all__") return 0.7;
        return (bd === b) ? 1.1 : 0.5;
      });

    // OD nodes
    if (selectedPrimary === null) {
      // Corridor overview mode: keep only nodes that belong to the current corridor.
      const inCorridorOverview =
        corridorMode &&
        !!activeCorridorId &&
        corridorOverviewZoneIds &&
        corridorOverviewZoneIds.size > 0;

      if (inCorridorOverview) {
        odNodesSel
          .attr("opacity", d => corridorOverviewZoneIds.has(d.id) ? 1 : 0)
          .attr("pointer-events", d => corridorOverviewZoneIds.has(d.id) ? "auto" : "none");
      } else {
        // Normal borough-based behavior when not in corridor overview
        odNodesSel
          .attr("opacity", d => (b === "__all__" || d.borough === b) ? 1 : 0.2)
          .attr("pointer-events", d => (b === "__all__" || d.borough === b) ? "auto" : "none");
      }
    }

    // HOTSPOT polygons (left panel)
    hotZonePaths
      .attr("fill-opacity", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        const inFilter = (b === "__all__" || bd === b);

        if (selectedPrimary !== null) {
          return id === selectedPrimary ? 1 : 0.15;
        }

        if (b === "__all__") {
          return 0.95;
        }

        return inFilter ? 0.95 : 0.15;
      })
      .attr("stroke-width", d => {
        const id = +d.properties.LocationID;
        if (selectedPrimary !== null && id === selectedPrimary) {
          return 1.4;
        }
        return 0.7;
      })
      .attr("stroke", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        const inFilter = (b === "__all__" || bd === b);

        if (selectedPrimary !== null) {
          if (id === selectedPrimary) return "#7e22ce";
          if (b !== "__all__" && inFilter) return "#7e22ce";
          return "rgba(148,163,184,.6)";
        }

        if (b === "__all__") {
          return "#000";
        }
        if (!inFilter) return "rgba(148,163,184,.6)";
        return "#7e22ce";
      })
      .attr("pointer-events", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        if (b !== "__all__" && bd !== b) return "none";
        return "auto";
      });
  }

  // ----- Adjust OD zoom to keep flows in frame -----
  function adjustOdZoomToFlows(primaryId, shownPairs) {
    if (!shownPairs || !shownPairs.length) return;

    const ids = new Set([primaryId, ...shownPairs.map(p => p.otherId)]);

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    odZonePoints.forEach(pt => {
      if (!ids.has(pt.id)) return;
      const x = pt.x, y = pt.y;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    });
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return;

    const pad = 40;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    const scale = Math.max(
      1,
      Math.min(6, 0.9 / Math.max(dx / odWidth, dy / odHeight))
    );

    const tx = odWidth / 2 - scale * cx;
    const ty = odHeight / 2 - scale * cy;

    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);

    isAutoZooming = true;
    odSvg
      .interrupt()
      .transition()
      .duration(400)
      .ease(d3.easeCubicInOut)
      .call(odZoom.transform, t)
      .on("end", () => { isAutoZooming = false; })
      .on("interrupt", () => { isAutoZooming = false; });
  }

  // ----- Core: render flows for the selected primary zone -----
  function renderODForPrimary() {
    corridorOverviewZoneIds = null;
    const hour      = +hourEl.value;
    const primaryId = selectedPrimary;
    const primary   = idTo.get(primaryId);
    if (!primary) return;

    const relevant = flows.filter(d =>
      d.time_bin === hour &&
      (d.origin_zone === primaryId || d.destination_zone === primaryId)
    );

    const byOther       = new Map();
    const corridorTotals = new Map(); // total trips per corridor for this zone+hour

    for (const row of relevant) {
      const isOut   = row.origin_zone === primaryId;
      const otherId = isOut ? row.destination_zone : row.origin_zone;

      if (!byOther.has(otherId)) {
        byOther.set(otherId, {
          otherId,
          outCount: 0,
          inCount: 0,
          clusterCounts: new Map()
        });
      }
      const ent = byOther.get(otherId);

      if (isOut) ent.outCount += row.trip_count;
      else       ent.inCount += row.trip_count;

      const cid = row.flow_cluster_id;
      if (cid !== null) {
        const prev = ent.clusterCounts.get(cid) || 0;
        ent.clusterCounts.set(cid, prev + row.trip_count);
      }
    }

    const pairsAll = Array.from(byOther.values());
    pairsAll.forEach(p => {
      p.total = p.outCount + p.inCount;

      const clusterEntries = Array.from(p.clusterCounts.entries());
      if (clusterEntries.length) {
        clusterEntries.sort((a, b) => d3.descending(a[1], b[1]));
        const dominantCid = clusterEntries[0][0];
        p.corridorClusterId = dominantCid;

        const old = corridorTotals.get(dominantCid) || 0;
        corridorTotals.set(dominantCid, old + p.total);
      } else {
        p.corridorClusterId = null;
      }
    });

    const maxTotalAll = d3.max(pairsAll, d => d.total) || 1;

    let pairs = pairsAll;
    if (selectedSecondary !== null) {
      pairs = pairsAll.filter(p => p.otherId === selectedSecondary);
    }
    pairs.sort((a, b) => d3.ascending(a.total, b.total));

    const capForPrimary = zoneCapMap.get(primaryId) ?? 20;
    let shownPairs = pairs;
    let showingMsg = "";
    if (selectedSecondary === null && Number.isFinite(capForPrimary)) {
      if (pairs.length > capForPrimary) {
        shownPairs = pairs.slice(pairs.length - capForPrimary);
        showingMsg = ` Showing ${shownPairs.length} of ${pairs.length} for readability.`;
      }
    }

    // 🔹 Update available corridors for this zone + hour
    const rawCorridors = Array.from(corridorTotals.entries())
      .filter(([cluster_id]) => semantics && semantics[cluster_id] != null)
      .map(([cluster_id, total_trip]) => {
        const label = window.readableClusterLabel(cluster_id);
        const key   = window.canonicalCorridorKeyFromLabel(label);
        return { cluster_id, total_trip, label, key };
      });

    const corridorIdSet = new Set(rawCorridors.map(c => c.cluster_id));

    corridorKeyToClusterIds = new Map();
    const grouped = new Map();
    rawCorridors.forEach(c => {
      const key = c.key || c.label;
      if (!grouped.has(key)) {
        grouped.set(key, { key, label: key, total_trip: 0 });
        corridorKeyToClusterIds.set(key, new Set());
      }
      const g = grouped.get(key);
      g.total_trip += c.total_trip;
      corridorKeyToClusterIds.get(key).add(c.cluster_id);
    });

    availableCorridors = Array.from(grouped.values())
      .sort((a, b) => d3.descending(a.total_trip, b.total_trip));

    if (activeCorridorId !== null && !corridorKeyToClusterIds.has(activeCorridorId)) {
      activeCorridorId = null;
    }

    if (availableCorridors.length > 0) {
      odCorridorControls.style.display = "block";

      if (corridorBtn) {
        corridorBtn.style.display = "none";
      }

      corridorFilterEl.style.display = "inline-block";

      const options = [
        `<option value="__all__">All corridors for this zone</option>`,
        ...availableCorridors.map(c => {
          return `<option value="${c.key}">${c.label}</option>`;
        })
      ];
      corridorFilterEl.innerHTML = options.join("");

      let currentValue = "__all__";
      if (corridorMode && activeCorridorId !== null) {
        currentValue = String(activeCorridorId);
      }
      corridorFilterEl.value = currentValue;

      corridorMode = true;

    } else {
      odCorridorControls.style.display = "none";
      corridorFilterEl.style.display   = "none";
      corridorFilterEl.innerHTML       = "";
      corridorMode                     = false;
      activeCorridorId                 = null;

      if (corridorBtn) {
        corridorBtn.style.display = "none";
      }
    }

    let displayedPairs = shownPairs;
    if (corridorMode) {
      displayedPairs = shownPairs.filter(p => {
        if (p.corridorClusterId === null) return false;
        if (!corridorIdSet.has(p.corridorClusterId)) return false;

        if (activeCorridorId) {
          const set = corridorKeyToClusterIds.get(activeCorridorId);
          if (!set) return false;
          if (!set.has(p.corridorClusterId)) return false;
        }
        return true;
      });
    }

    const flowColor = d3.scaleLinear()
      .domain([
        0,
        maxTotalAll * 0.05,
        maxTotalAll * 0.5,
        maxTotalAll * 0.95,
        maxTotalAll
      ])
      .range([
        "rgba(32, 64, 128, 0.85)",
        "rgba(59, 131, 189, 0.78)",
        "rgba(138, 86, 178, 0.82)",
        "rgba(203, 53, 42, 0.88)",
        "rgba(146, 20, 12, 0.90)"
      ]);

    const widthScale = d3.scaleSqrt()
      .domain([0, maxTotalAll])
      .range([1, 5.5]);

    odEdgesG.selectAll("*").remove();
    const connectedIds = new Set([primaryId, ...displayedPairs.map(p => p.otherId)]);

    odNodesSel
      .attr("opacity", d => {
        if (!connectedIds.size) {
          if (corridorMode && d.id === primaryId) return 1;
          return corridorMode ? 0 : (connectedIds.has(d.id) ? 1 : 0.08);
        }
        if (corridorMode) {
          return connectedIds.has(d.id) ? 1 : 0;
        }
        return connectedIds.has(d.id) ? 1 : 0.08;
      })
      .attr("pointer-events", d => {
        if (!connectedIds.size && corridorMode) {
          return d.id === primaryId ? "auto" : "none";
        }
        return connectedIds.has(d.id) ? "auto" : "none";
      })
      .classed("selected", d => d.id === primaryId || d.id === selectedSecondary);

    const routeGroups = odEdgesG.selectAll("g.route")
      .data(displayedPairs, d => d.otherId)
      .enter()
      .append("g")
      .attr("class", "route");

    routeGroups.each(function(d) {
      const g  = d3.select(this);
      const c1 = odZonePoints.find(z => z.id === primaryId);
      const c2 = odZonePoints.find(z => z.id === d.otherId);
      if (!c1 || !c2) return;

      const strokeCol = flowColor(d.total);
      const sw        = widthScale(d.total);

      const thePath = (function(p1, p2) {
        const mx = (p1[0] + p2[0]) / 2;
        const my = (p1[1] + p2[1]) / 2 - 14;
        const p  = d3.path();
        p.moveTo(p1[0], p1[1]);
        p.quadraticCurveTo(mx, my, p2[0], p2[1]);
        return p.toString();
      })([c1.x, c1.y], [c2.x, c2.y]);

      // main visible line
      g.append("path")
        .attr("class", "edge")
        .attr("stroke", strokeCol)
        .attr("stroke-width", sw)
        .attr("stroke-linecap", "round")
        .attr("stroke-opacity", 0.98)
        .style("filter",
          corridorMode
            ? "drop-shadow(0 0 2px rgba(245, 158, 11, 0.75))"
            : "none"
        )
        .attr("d", thePath);

      // wide invisible hit area for hover/click
      g.append("path")
        .attr("class", "edge-hit")
        .attr("d", thePath)
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", Math.max(sw + 8, 12))
        .on("mousemove", (event) => {
          if (isAutoZooming) return;

          const other = idTo.get(d.otherId);
          let dirLabel;
          if (primary.zone && other.zone && primary.zone === other.zone) {
            dirLabel = `Intra ${primary.zone}`;
          } else {
            dirLabel = `${primary.zone} ↔ ${other.zone}`;
          }
          const totalStr = d.total.toLocaleString();

          let html = `
            <div style="font-weight:600;margin-bottom:2px;">${dirLabel}</div>
            <div style="font-size:12px;margin-bottom:2px;">
              ${fmtHour(hour)} • ${totalStr} trips
            </div>
          `;

          if (d.outCount > 0 || d.inCount > 0) {
            const pb = primary.borough;
            const ob = other.borough;
            html += `<div style="font-size:11px;margin-top:2px;">`;

            if (pb && ob && pb === ob) {
              const totalDir = d.outCount + d.inCount;
              html += `<div>Within ${pb}: ${totalDir.toLocaleString()} trips (both directions)</div>`;
            } else {
              if (d.outCount > 0) {
                html += `<div>${pb} → ${ob}: ${d.outCount.toLocaleString()}</div>`;
              }
              if (d.inCount > 0) {
                html += `<div>${ob} → ${pb}: ${d.inCount.toLocaleString()}</div>`;
              }
            }

            html += `</div>`;
          }

          if (d.corridorClusterId !== null && corridorIdSet.has(d.corridorClusterId)) {
            const label = window.readableClusterLabel(d.corridorClusterId);
            html += `
              <div style="margin-top:4px;font-size:11px;">
                <span style="display:inline-block;padding:2px 6px;border-radius:999px;
                            border:1px solid #cbd5e1;background:#f8fafc;">
                  Corridor: ${label}
                </span>
              </div>
            `;
          }

          odTip.style("opacity", 1)
            .style("left", (event.offsetX + 12) + "px")
            .style("top",  (event.offsetY + 12) + "px")
            .html(html);
        })
        .on("mouseleave", () => {
          if (isAutoZooming) return;
          odTip.style("opacity", 0);
        })
        .on("click", (event) => {
          event.stopPropagation();
          selectedSecondary = d.otherId;
          renderODForPrimary();
        });
    });

    odSummary.html(() => {
      const base = `<b>${primary.zone} - ${primary.borough}</b> at ${fmtHour(hour)} — ${pairsAll.length} connected zones.`;
      return showingMsg ? (base + showingMsg) : base;
    });
    odDbg.text(`Max flow for this zone @ hour: ${maxTotalAll.toLocaleString()}`);
    odLegendNote.text(`Scaled 0 → ${maxTotalAll.toLocaleString()} trips for this zone & hour.`);

    applyBoroughFilter();

    // Only auto-zoom the first time we render for this primary
    if (!autoZoomedPrimaries.has(primaryId)) {
      adjustOdZoomToFlows(primaryId, shownPairs);
      autoZoomedPrimaries.add(primaryId);
    }
  }

  // ----- NEW: render many-to-many corridor overview -----
  function renderCorridorOverview(corridorKey) {
    // Use canonical key so it matches how semantics are grouped
    const canonicalKey = window.canonicalCorridorKeyFromLabel
      ? window.canonicalCorridorKeyFromLabel(corridorKey)
      : corridorKey;

    const hour      = +hourEl.value;
    const semantics = window.semantics || {};

    // Ensure corridor state reflects this overview; remember for back navigation.
    corridorMode             = true;
    activeCorridorId         = canonicalKey;
    lastCorridorOverviewKey  = canonicalKey;

    // 1) Find all cluster_ids whose label collapses to this corridor key
    const corridorClusterIds = new Set();
    Object.entries(semantics).forEach(([cid, info]) => {
      if (!info || !info.label) return;
      const k = window.canonicalCorridorKeyFromLabel(info.label);
      if (k === canonicalKey) {
        corridorClusterIds.add(+cid);
      }
    });

    // Guard: no clusters for this corridor
    if (!corridorClusterIds.size) {
      odEdgesG.selectAll("*").remove();
      odSummary.textContent =
        `No clusters found for corridor "${canonicalKey}".`;
      odDbg.text("");
      odLegendNote.text("");
      return;
    }

    // 2) Collect all flows in this corridor at the selected hour
    const relevant = flows.filter(row =>
      row.time_bin === hour &&
      row.flow_cluster_id != null &&
      corridorClusterIds.has(row.flow_cluster_id)
    );

    if (!relevant.length) {
      odEdgesG.selectAll("*").remove();
      odSummary.textContent =
        `No trips in corridor "${canonicalKey}" at ${fmtHour(hour)}.`;
      odDbg.text("");
      odLegendNote.text("");
      return;
    }

    // 3) Aggregate by directed OD pair
    const byPair = new Map();
    relevant.forEach(row => {
      const key = `${row.origin_zone}|${row.destination_zone}`;
      let ent = byPair.get(key);
      if (!ent) {
        ent = {
          originId: row.origin_zone,
          destId:   row.destination_zone,
          total:    0
        };
        byPair.set(key, ent);
      }
      ent.total += row.trip_count;
    });

    const pairs = Array.from(byPair.values());
    const maxTotal = d3.max(pairs, d => d.total) || 1;

    // 4) Which zones participate?
    const zoneIds = new Set();
    pairs.forEach(p => {
      zoneIds.add(p.originId);
      zoneIds.add(p.destId);
    });

    // Remember these for corridor overview, so hour changes / filters
    // don't accidentally bring back irrelevant nodes.
    corridorOverviewZoneIds = zoneIds;

    // 5) Reset selection state + clear existing edges
    selectedPrimary   = null;
    selectedSecondary = null;

    odEdgesG.selectAll("*").remove();

    // Node styling: highlight only zones in this corridor
    odNodesSel
      .attr("opacity", d => zoneIds.has(d.id) ? 1 : 0)
      .attr("pointer-events", d => zoneIds.has(d.id) ? "auto" : "none")
      .classed("selected", false);

    // Flow color + width scales (same style as single-zone view)
    const flowColor = d3.scaleLinear()
      .domain([
        0,
        maxTotal * 0.05,
        maxTotal * 0.5,
        maxTotal * 0.95,
        maxTotal
      ])
      .range([
        "rgba(32, 64, 128, 0.85)",
        "rgba(59, 131, 189, 0.78)",
        "rgba(138, 86, 178, 0.82)",
        "rgba(203, 53, 42, 0.88)",
        "rgba(146, 20, 12, 0.90)"
      ]);

    const widthScale = d3.scaleSqrt()
      .domain([0, maxTotal])
      .range([1, 5.5]);

    // 6) Draw arcs for each OD pair in the corridor
    const routeGroups = odEdgesG.selectAll("g.route")
      .data(pairs, d => `${d.originId}-${d.destId}`)
      .enter()
      .append("g")
      .attr("class", "route");

    routeGroups.each(function(d) {
      const g  = d3.select(this);
      const c1 = odZonePoints.find(z => z.id === d.originId);
      const c2 = odZonePoints.find(z => z.id === d.destId);
      if (!c1 || !c2) return;

      const strokeCol = flowColor(d.total);
      const sw        = widthScale(d.total);

      const pathStr = (function(p1, p2) {
        const mx = (p1[0] + p2[0]) / 2;
        const my = (p1[1] + p2[1]) / 2 - 14;
        const p  = d3.path();
        p.moveTo(p1[0], p1[1]);
        p.quadraticCurveTo(mx, my, p2[0], p2[1]);
        return p.toString();
      })([c1.x, c1.y], [c2.x, c2.y]);

      // visible arc
      g.append("path")
        .attr("class", "edge")
        .attr("stroke", strokeCol)
        .attr("stroke-width", sw)
        .attr("stroke-linecap", "round")
        .attr("stroke-opacity", 0.98)
        .style("filter", "drop-shadow(0 0 2px rgba(245, 158, 11, 0.75))")
        .attr("d", pathStr);

      // hit area for hover + click (don’t bubble to odSvg)
      g.append("path")
        .attr("class", "edge-hit")
        .attr("d", pathStr)
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", Math.max(sw + 8, 12))
        .on("mousemove", (event) => {
          if (isAutoZooming) return;

          const oInfo = idTo.get(d.originId);
          const tInfo = idTo.get(d.destId);
          const originName = oInfo ? `${oInfo.zone} - ${oInfo.borough}` : d.originId;
          const destName   = tInfo ? `${tInfo.zone} - ${tInfo.borough}` : d.destId;

          const html = `
            <div style="font-weight:600;margin-bottom:2px;">
              ${originName} → ${destName}
            </div>
            <div style="font-size:12px;margin-bottom:2px;">
              ${fmtHour(hour)} • ${d.total.toLocaleString()} trips
            </div>
            <div style="margin-top:4px;font-size:11px;">
              <span style="display:inline-block;padding:2px 6px;border-radius:999px;
                          border:1px solid #cbd5e1;background:#f8fafc;">
                Corridor: ${canonicalKey}
              </span>
            </div>
          `;

          odTip
            .style("opacity", 1)
            .style("left", (event.offsetX + 12) + "px")
            .style("top",  (event.offsetY + 12) + "px")
            .html(html);
        })
        .on("mouseleave", () => {
          if (isAutoZooming) return;
          odTip.style("opacity", 0);
        })
        .on("click", (event) => {
          // IMPORTANT: prevent click from reaching odSvg (which would reset the view)
          event.stopPropagation();

          // Leaving corridor overview; clear the overview zone cache.
          corridorOverviewZoneIds = null;

          // Drill down to a normal per-zone view anchored on this edge.
          // Use the origin as primary and the destination as secondary.
          selectedPrimary   = d.originId;
          selectedSecondary = d.destId;

          // Stay in corridor mode, locked to this corridor.
          corridorMode     = true;
          activeCorridorId = canonicalKey;

          // Render standard OD view with corridor filter applied.
          renderODForPrimary();
        });
    });

    // 7) Summary + legend note
    odSummary.textContent =
      `Corridor overview: ${canonicalKey} at ${fmtHour(hour)} — ` +
      `${pairs.length} OD pairs, ${relevant.length.toLocaleString()} raw flow rows.`;
    odDbg.text(`Max flow in corridor @ hour: ${maxTotal.toLocaleString()}`);
    odLegendNote.text(`Scaled 0 → ${maxTotal.toLocaleString()} trips within this corridor.`);

    // 8) Auto-zoom to all participating zones on the OD map
    (function autoZoomToZoneSet(ids) {
      if (!ids || !ids.size) return;

      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      odZonePoints.forEach(pt => {
        if (!ids.has(pt.id)) return;
        const x = pt.x, y = pt.y;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      });
      if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return;

      const pad = 40;
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;

      const dx = x1 - x0;
      const dy = y1 - y0;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;

      const scale = Math.max(
        1,
        Math.min(6, 0.9 / Math.max(dx / odWidth, dy / odHeight))
      );
      const tx = odWidth / 2 - scale * cx;
      const ty = odHeight / 2 - scale * cy;

      const t = d3.zoomIdentity.translate(tx, ty).scale(scale);

      isAutoZooming = true;
      odSvg
        .interrupt()
        .transition()
        .duration(400)
        .ease(d3.easeCubicInOut)
        .call(odZoom.transform, t)
        .on("end", () => { isAutoZooming = false; })
        .on("interrupt", () => { isAutoZooming = false; });
    })(zoneIds);
  }

  // expose these to other modules
  window.clearSelectionAndReset = clearSelectionAndReset;
  window.zoomToBorough         = zoomToBorough;
  window.zoomToZone            = zoomToZone;
  window.applyBoroughFilter    = applyBoroughFilter;
  window.renderODForPrimary    = renderODForPrimary;
  window.renderCorridorOverview = renderCorridorOverview;
}

// Expose initializer for wiring.js
window.initODMap = initODMap;