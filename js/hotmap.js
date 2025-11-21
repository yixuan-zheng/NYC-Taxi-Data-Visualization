// ===============================================
// Base map scaffolding (create SVG groups + paths)
// ===============================================
let hotSvg, hotRoot, hotZonePaths, hotTip, hotStats, hotZoom;
let hotWidth, hotHeight;

let odSvg, odRoot, odZonesG, odEdgesG, odNodesG;
let odWidth, odHeight;

window.activeTimeClusterId = null;

/**
 * Create the left (hotspot) and right (OD) base maps.
 * Called from wiring.js AFTER data is loaded (window.zones is ready).
 */
function initHotMap() {
  const zones = window.zones;
  if (!zones || !zones.features) {
    console.error("initHotMap: window.zones is not loaded yet");
    return;
  }

  // ----- HOTSPOT MAP (LEFT) -----
  hotSvg = d3.select("#hotSvg");
  hotTip = d3.select("#hotTip");
  hotStats = d3.select("#hotStats");

  const hotWrap = document.getElementById("hotMap");
  hotWidth  = hotWrap?.clientWidth  || 520;
  hotHeight = hotWrap?.clientHeight || 520;

  hotSvg
    .attr("width", hotWidth)
    .attr("height", hotHeight);

  const hotProjection = d3.geoMercator().fitSize([hotWidth, hotHeight], zones);
  const hotPath = d3.geoPath().projection(hotProjection);

  hotRoot = hotSvg.append("g").attr("class", "hot-root");

  hotZonePaths = hotRoot.selectAll("path.hot-zone")
    .data(zones.features)
    .join("path")
    .attr("class", "hot-zone")
    .attr("d", hotPath)
    .attr("fill", "#ffffff")
    .attr("stroke", "#000")
    .attr("stroke-width", 0.7);

  hotZoom = d3.zoom()
    .scaleExtent([1, 6])
    .on("zoom", (event) => {
      hotRoot.attr("transform", event.transform);
    });

  hotSvg.call(hotZoom);

  // 🔹 NEW: click on whitespace in the hotspot map to clear selection
  hotSvg.on("click", (event) => {
    // Ignore if we're mid auto-zoom animation
    if (typeof isAutoZooming !== "undefined" && isAutoZooming) return;

    // If a zone path handled the click, its handler called stopPropagation,
    // so we only get here for true background / whitespace clicks.
    if (typeof clearSelectionAndReset === "function") {
      clearSelectionAndReset();
    } else {
      // Fallback: just clear selection + repaint
      if (typeof selectedPrimary   !== "undefined") selectedPrimary   = null;
      if (typeof selectedSecondary !== "undefined") selectedSecondary = null;
      if (typeof restoreViews === "function") restoreViews();
    }
  });

  // expose hotspot map pieces
  window.hotSvg       = hotSvg;
  window.hotRoot      = hotRoot;
  window.hotZonePaths = hotZonePaths;
  window.hotPath      = hotPath;
  window.hotWidth     = hotWidth;
  window.hotHeight    = hotHeight;
  window.hotZoom      = hotZoom;
  window.hotTip       = hotTip;
  window.hotStats     = hotStats;

  // Ensure borough filter handle is globally visible
  window.boroFilterEl = window.boroFilterEl || document.getElementById("boroughFilter");

  // ----- OD MAP (RIGHT) -----
  odSvg = d3.select("#odSvg");

  const odWrap = document.getElementById("odMap");
  odWidth  = odWrap?.clientWidth  || 520;
  odHeight = odWrap?.clientHeight || 520;

  // OD tooltip
  const odTipSel = d3.select("#odTip");
  window.odTip = odTipSel;

  odSvg
    .attr("width", odWidth)
    .attr("height", odHeight);

  const odProjection = d3.geoMercator().fitSize([odWidth, odHeight], zones);
  const odPath = d3.geoPath().projection(odProjection);

  odRoot   = odSvg.append("g").attr("class", "od-root");
  odZonesG = odRoot.append("g").attr("class", "od-zones");
  odEdgesG = odRoot.append("g").attr("class", "od-edges");
  odNodesG = odRoot.append("g").attr("class", "od-nodes");

  // expose OD map pieces so odmap.js can use them
  window.odSvg    = odSvg;
  window.odRoot   = odRoot;
  window.odZonesG = odZonesG;
  window.odEdgesG = odEdgesG;
  window.odNodesG = odNodesG;
  window.odPath   = odPath;
  window.odWidth  = odWidth;
  window.odHeight = odHeight;
}

// Make initHotMap visible to wiring.js
window.initHotMap = initHotMap;


// ===============================================
// Hotspot state + repaint logic
// ===============================================

// These will be filled once data is loaded
let stKey;
let stByKey;
let maxIntensityHour;
let hotColor;

// Initialize hotspot state *after* `window.st` is populated (by wiring.js)
function initHotmapState() {
  if (!window.st) {
    console.error("initHotmapState: window.st is not set yet");
    return;
  }

  // spatiotemporal lookup
  stKey = (loc, h) => `${loc}|${h}`;
  stByKey = new Map(window.st.map(d => [stKey(d.LocationID, d.hour), d]));

  // hotspot color
  maxIntensityHour = d3.max(window.st, d => d.intensity_hour) || 1;
  hotColor = d3.scaleQuantize()
    .domain([0, maxIntensityHour])
    .range(d3.schemeYlOrRd[7].slice(1));

  // legend labels
  const startVal = 0;
  const midVal = Math.round(maxIntensityHour / 2 / 1000) * 1000;
  const endVal = Math.round(maxIntensityHour / 1000) * 1000;

  document.getElementById("legendStart").textContent = startVal.toLocaleString();
  document.getElementById("legendMid").textContent  = midVal.toLocaleString();
  document.getElementById("legendEnd").textContent  = endVal.toLocaleString();

  d3.select("#legendNote").text(`0 → ${endVal.toLocaleString()} trips/hour`);

  // also expose so other modules could reuse if needed
  window.stKey      = stKey;
  window.stByKey    = stByKey;
  window.maxIntensityHour = maxIntensityHour;
  window.hotColor   = hotColor;
}

// hotspot repaint
function repaintHot() {
  // Guard if map or slider not ready yet
  if (!window.hotZonePaths || !window.hourEl || !stByKey || !hotColor) return;

  const hourEl  = window.hourEl;
  const fmtHour = window.fmtHour || (h => (h < 10 ? "0" + h : h) + ":00");
  const hour    = +hourEl.value;

  const idToMap = window.idTo || new Map();

  hotZonePaths
    .attr("fill", d => {
      const id  = +d.properties.LocationID;
      const row = stByKey.get(`${id}|${hour}`);
      const val = row ? +row.intensity_hour : 0;
      return hotColor(val);
    })
    .attr("fill-opacity", 0.95)
    .attr("stroke", d => {
      const id  = +d.properties.LocationID;
      const row = stByKey.get(`${id}|${hour}`);
      return row && +row.cluster_id === -1 ? "#dc2626" : "#000";
    })
    .on("mousemove", (event, d) => {
      const id  = +d.properties.LocationID;
      const row = stByKey.get(`${id}|${hour}`);

      const zoneName = d.properties.Zone || idToMap.get(id)?.zone || "Unknown zone";
      const borough  = d.properties.Borough || idToMap.get(id)?.borough || "";
      const isSelected = (typeof selectedPrimary !== "undefined" &&
                          selectedPrimary !== null &&
                          id === selectedPrimary);

      highlightBoth(id);

      let html = "";

      if (typeof selectedPrimary !== "undefined" &&
          selectedPrimary !== null && !isSelected) {
        html = `<div><b>${zoneName}</b>${borough ? " — " + borough : ""}</div>`;
      } else {
        html = `<div><b>${zoneName}</b>${borough ? " — " + borough : ""}</div>`;
        html += `<div>Hour: ${fmtHour(hour)}</div>`;
        html += `<div>Trips (this hour): ${
          row ? (+row.intensity_hour).toLocaleString() : 0
        }</div>`;
        html += `<div>Avg fare (this hour): ${
          row && isFinite(+row.avg_fare_hour)
            ? "$" + (+row.avg_fare_hour).toFixed(2)
            : "—"
        }</div>`;
        html += `<div>Avg duration (this hour): ${
          row && isFinite(+row.avg_duration_min_hour)
            ? (+row.avg_duration_min_hour).toFixed(1) + " min"
            : "—"
        }</div>`;
      }

      hotTip
        .style("opacity", 1)
        .style("left", (event.offsetX + 12) + "px")
        .style("top",  (event.offsetY + 12) + "px")
        .html(html);
    })
    .on("mouseleave", () => {
      hotTip.style("opacity", 0);
      if (typeof currentHoverId !== "undefined") {
        currentHoverId = null;
      }
      restoreViews();
    })
    .on("click", (event, d) => {
      event.stopPropagation();

      if (typeof isAutoZooming !== "undefined" && isAutoZooming) return;

      const id = +d.properties.LocationID;

      const boroFilterEl = window.boroFilterEl || document.getElementById("boroughFilter");
      const b = boroFilterEl ? boroFilterEl.value : "__all__";

      const getZoneBoroughById = window.getZoneBoroughById || (() => "Unknown");
      const bd = getZoneBoroughById(id);
      const inFilter = (b === "__all__" || bd === b);
      if (!inFilter) return;

      // update shared selection (relies on global bindings from odmap.js)
      selectedPrimary   = id;
      selectedSecondary = null;

      if (typeof renderODForPrimary === "function") {
        renderODForPrimary();
      }

      const hour = +window.hourEl.value;
      if (typeof showClusterForZoneAndHour === "function") {
        showClusterForZoneAndHour(id, hour);
      }
    });

  if (hotStats) {
    hotStats.text(
      `Spatiotemporal • Hour: ${fmtHour(hour)} • Max intensity: ${maxIntensityHour.toLocaleString()} trips/hour`
    );
  }

  // If a specific time-series cluster is active in Cluster view,
  // re-apply its highlight after repaint.
  if (window.clusterTimeViewActive &&
      window.activeTimeClusterId != null &&
      typeof window.highlightZonesForTimeCluster === "function") {
    window.highlightZonesForTimeCluster(window.activeTimeClusterId);
  }
}

// paint OD dots with hotspot colors
function paintOdNodesFromHot() {
  if (typeof odNodesSel === "undefined" || !window.hourEl || !stByKey || !hotColor) return;

  const hour = +window.hourEl.value;

  odNodesSel
    .attr("fill", d => {
      const row = stByKey.get(`${d.id}|${hour}`);
      const val = row ? +row.intensity_hour : 0;
      return hotColor(val);
    })
    .attr("fill-opacity", 0.9);
}

function highlightZonesForTimeCluster(clusterId) {
  if (!window.hotZonePaths || !stByKey || !stKey || !window.hourEl) return;

  const hour = +window.hourEl.value;

  hotZonePaths.each(function(d) {
    const id  = +d.properties.LocationID;
    const row = stByKey.get(stKey(id, hour));
    const inCluster = row && row.cluster_id != null && +row.cluster_id === +clusterId;

    const sel = d3.select(this);

    if (inCluster) {
      // In the chosen time-series cluster: bright + purple border
      sel
        .attr("fill-opacity", 0.95)
        .attr("stroke", "#7e22ce")
        .attr("stroke-width", 1.6);
    } else {
      // Everything else: dimmed but still visible
      sel
        .attr("fill-opacity", 0.15)
        .attr("stroke", "#cbd5e1")
        .attr("stroke-width", 0.6);
    }
  });
}
window.highlightZonesForTimeCluster = highlightZonesForTimeCluster;

function setActiveTimeClusterOnMap(clusterId) {
  window.activeTimeClusterId = clusterId;

  // Only meaningful when cluster time view is on
  if (window.clusterTimeViewActive) {
    if (typeof repaintHot === "function") {
      repaintHot();
    }
    highlightZonesForTimeCluster(clusterId);
  }
}
window.setActiveTimeClusterOnMap = setActiveTimeClusterOnMap;

function isZoneInTopTimeCluster(zoneId) {
  // Only relevant when the cluster time-series tab is active
  if (!window.clusterTimeViewActive) return false;
  if (!stByKey || !stKey || !window.hourEl) return false;
  if (typeof window.getTopTimeClusterIds !== "function") return false;

  const hour = +window.hourEl.value;
  const row = stByKey.get(stKey(zoneId, hour));
  if (!row || row.cluster_id == null || !isFinite(+row.cluster_id)) return false;

  // Cache the top-cluster ID set so we don't rebuild it on every call
  if (!window._topTimeClusterIdSet) {
    const ids = window.getTopTimeClusterIds() || [];
    window._topTimeClusterIdSet = new Set(ids.map(Number));
  }
  return window._topTimeClusterIdSet.has(+row.cluster_id);
}

function highlightTopTimeClustersForCurrentHour() {
  if (!window.clusterTimeViewActive) return;
  if (!window.hotZonePaths || !stByKey || !stKey || !window.hourEl) return;
  if (typeof window.getTopTimeClusterIds !== "function") return;

  const hour = +window.hourEl.value;
  const topIds = window.getTopTimeClusterIds().map(Number);
  const topSet = new Set(topIds);

  // keep cache in sync
  window._topTimeClusterIdSet = new Set(topIds);

  hotZonePaths.each(function(d) {
    const id  = +d.properties.LocationID;
    const row = stByKey.get(stKey(id, hour));
    if (!row || row.cluster_id == null || !isFinite(+row.cluster_id)) return;

    const cid = +row.cluster_id;
    if (!topSet.has(cid)) return;

    d3.select(this)
      .attr("stroke", "#7e22ce")  // purple like selection
      .attr("stroke-width", 1.8);
  });
}

// ===============================================
// Cross-highlighting (left ↔ right)
// ===============================================
function highlightBoth(zoneId) {
  if (typeof currentHoverId !== "undefined") {
    currentHoverId = zoneId;
      if (window.clusterTimeViewActive && window.activeTimeClusterId != null) {
      return;
    }
  }

  const boroFilterEl = window.boroFilterEl || document.getElementById("boroughFilter");
  const b = boroFilterEl ? boroFilterEl.value : "__all__";

  const hasSelection = (typeof selectedPrimary !== "undefined" &&
                        selectedPrimary !== null);

  const getZoneBoroughById = window.getZoneBoroughById || (() => "Unknown");

  // --- HOTSPOT MAP (LEFT) ---
  if (window.hotZonePaths) {
    hotZonePaths
      .attr("fill-opacity", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        const inFilter = (b === "__all__" || bd === b);

        // Always keep out-of-borough zones dim when a filter is active
        if (!inFilter && b !== "__all__") {
          return 0.15;
        }

        // --------- CASE A: NO SELECTION ---------
        if (!hasSelection) {
          if (b === "__all__") {
            // All boroughs: hovered bright, others dim
            return id === zoneId ? 1 : 0.2;
          } else {
            // Borough selected: hovered bright, other in-borough moderately dim
            return id === zoneId ? 1 : 0.35;
          }
        }

        // --------- CASE B: SELECTION ACTIVE ---------

        // Hovering the selected zone itself
        if (id === selectedPrimary && id === zoneId) {
          return 1;
        }

        // Selected zone (not currently hovered) stays bright
        if (id === selectedPrimary) {
          return 0.9;
        }

        // Hovered *other* zone should pop strongly too
        if (id === zoneId) {
          return 1;
        }

        // Other in-borough zones: softly dimmed but still visible
        return 0.25;
      })
      .attr("stroke-width", d => {
        const id = +d.properties.LocationID;

        let w;

        // Base behavior
        if (!hasSelection) {
          w = (id === zoneId ? 1.5 : 0.7);
        } else {
          if (id === selectedPrimary)      w = 1.6;
          else if (id === zoneId)          w = 1.2;
          else                             w = 0.7;
        }

        // If this zone belongs to one of the top time-series clusters
        // while cluster view is active, keep it visibly emphasized.
        if (isZoneInTopTimeCluster(id)) {
          w = Math.max(w, 1.8);
        }

        return w;
      })
      .attr("stroke", d => {
        const id = +d.properties.LocationID;
        const bd = getZoneBoroughById(id);
        const inFilter = (b === "__all__" || bd === b);

        let stroke;

        // Base behavior
        if (!hasSelection) {
          if (b === "__all__") {
            // global mode: hovered gets purple border, others black
            stroke = (id === zoneId ? "#9333ea" : "#000");
          } else {
            // borough mode: in-borough zones get purple, others grey
            if (!inFilter) stroke = "rgba(148,163,184,.6)";
            else           stroke = "#7e22ce";
          }
        } else {
          if (!inFilter && b !== "__all__") {
            stroke = "rgba(148,163,184,.6)";
          } else if (id === selectedPrimary) {
            stroke = "#7e22ce";
          } else if (id === zoneId) {
            stroke = "#9333ea";
          } else if (b === "__all__") {
            stroke = "#000";
          } else {
            stroke = "#7e22ce";
          }
        }

        // Override: top time-series clusters always keep a purple border
        // in cluster view, even when hovering elsewhere.
        if (isZoneInTopTimeCluster(id)) {
          stroke = "#7e22ce";
        }

        return stroke;
      });
  }

  // --- OD NODES (RIGHT) ---
  if (typeof odNodesSel !== "undefined" && !hasSelection) {
    odNodesSel
      .attr("opacity", d => {
        const inFilter = (b === "__all__" || d.borough === b);
        if (!inFilter) return 0.2;          // dim out-of-borough nodes
        return d.id === zoneId ? 1 : 0.15;  // highlight hovered zone's dot, dim others
      });
  }
}

function restoreViews() {
  repaintHot();
  if (typeof selectedPrimary !== "undefined" &&
      selectedPrimary !== null &&
      typeof renderODForPrimary === "function") {
    renderODForPrimary();
  }
  if (typeof applyBoroughFilter === "function") {
    applyBoroughFilter();
  }
}

function showClusterForZoneAndHour(zoneId, hour) {
  if (!stByKey || !stKey) return;

  const row = stByKey.get(stKey(zoneId, hour));
  if (!row || row.cluster_id == null || !isFinite(+row.cluster_id)) return;

  const clusterId = +row.cluster_id;

  if (typeof renderClusterDetail === "function") {
    renderClusterDetail(clusterId);
  }
  if (typeof highlightClusterRow === "function") {
    highlightClusterRow(clusterId);
  }
}

// Expose hotmap utilities so wiring.js and odmap.js can call them
window.initHotmapState      = initHotmapState;
window.repaintHot           = repaintHot;
window.paintOdNodesFromHot  = paintOdNodesFromHot;
window.highlightBoth        = highlightBoth;
window.restoreViews         = restoreViews;
window.showClusterForZoneAndHour = showClusterForZoneAndHour; 
window.highlightTopTimeClustersForCurrentHour = highlightTopTimeClustersForCurrentHour;