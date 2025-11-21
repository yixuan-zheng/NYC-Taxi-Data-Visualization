// wiring.js
// Top-level bootstrapper: load data, set shared globals, initialize all views.

(async function () {
  // -------------------------------------------
  // 1. Basic hour controls + formatter
  // -------------------------------------------
  const hourEl = document.getElementById("hour");
  const hourLabel = document.getElementById("hourLabel");

  // OD / Cluster panel title + subtitle
  const odPanelTitle = document.getElementById("odPanelTitle");
  const odPanelSubtitle = document.getElementById("odPanelSubtitle");

  // Text for OD flows mode
  const OD_TITLE_TEXT = "City Flow: Origin-Destination Links";
  const OD_SUBTITLE_TEXT =
    "Interactive flow map. Click a dot to reveal connections.<br>Click a destination to isolate the path. Tap empty space to reset.";

  // Text for Cluster time patterns mode
  const CLUSTER_TITLE_TEXT =
    "Hourly Trends: 24h Activity Profiles";
  const CLUSTER_SUBTITLE_TEXT =
    "Select an area to view its daily rhythm. Hover for details.";

  function fmtHour(h) {
    return h.toString().padStart(2, "0") + ":00";
  }

  // Expose to other modules (hotmap / odmap / corridors / clusters)
  window.hourEl = hourEl;
  window.hourLabel = hourLabel;
  window.fmtHour = fmtHour;

  // Borough filter handle (used across modules)
  const boroFilterEl = document.getElementById("boroughFilter");
  window.boroFilterEl = boroFilterEl;

  // Track whether "Cluster time patterns" tab is active
  window.clusterTimeViewActive = false;

  // -------------------------------------------
  // 2. Load all data
  // -------------------------------------------
  const [
    zones,
    flows,
    lookup,
    st,
    tsData,
    semantics,       // flows semantics
    semanticsTime    // time-series (zone cluster) semantics
  ] = await Promise.all([
    d3.json("data/taxi_zones.geojson"),
    d3.csv("data/flows.csv", d3.autoType),
    d3.csv("data/taxi_zone_lookup.csv").catch(() => []),
    d3.csv("data/clusters_spatiotemporal.csv", d3.autoType),
    d3.csv("data/cluster_timeseries.csv", d3.autoType).catch(() => []),
    d3.json("data/cluster_semantics.json").catch(() => ({})),      // flows
    d3.json("data/cluster_semantics_t.json").catch(() => ({}))
  ]);

  // Put data on window so other modules can read it
  window.zones = zones;
  window.flows = flows;
  window.lookup = lookup;
  window.st = st;
  window.tsData = tsData || [];

  // Flows/corridors semantics (existing)
  window.semantics = semantics || {};      // keep for backward compatibility
  window.semanticsFlows = semantics || {};

  // Time-series (zone cluster) semantics (NEW)
  window.semanticsTime = semanticsTime || {};

  // -------------------------------------------
  // 3. Build csvLookup + idTo
  // -------------------------------------------
  const csvLookup = new Map();

  function normalizeBorough(b) {
    if (!b) return "Unknown";
    const s = String(b).trim().toLowerCase();
    if (s.includes("manhattan")) return "Manhattan";
    if (s.includes("brooklyn")) return "Brooklyn";
    if (s.includes("queens")) return "Queens";
    if (s.includes("bronx")) return "The Bronx";
    if (s.includes("staten")) return "Staten Island";
    return b;
  }

  lookup.forEach(r => {
    csvLookup.set(+r.LocationID, {
      zone: r.Zone,
      borough: normalizeBorough(r.Borough)
    });
  });
  window.csvLookup = csvLookup;

  // Master zone map id -> { id, zone, borough, feature }
  const idTo = new Map();
  zones.features.forEach(f => {
    const id = +f.properties.LocationID;
    const lk = csvLookup.get(id);
    idTo.set(id, {
      id,
      zone: lk ? lk.zone : (f.properties.Zone || ("Zone " + id)),
      borough: lk ? lk.borough : normalizeBorough(f.properties.Borough),
      feature: f
    });
  });
  window.idTo = idTo;

  // Helper to expose borough lookup to hotmap/odmap
  function getZoneBoroughById(id) {
    const info = idTo.get(id);
    return info ? info.borough : "Unknown";
  }
  window.getZoneBoroughById = getZoneBoroughById;

  // -------------------------------------------
  // 4. Spatiotemporal lookup + hotspot color
  // -------------------------------------------
  const stKey = (loc, h) => `${loc}|${h}`;
  const stByKey = new Map(st.map(d => [stKey(d.LocationID, d.hour), d]));
  window.stKey = stKey;
  window.stByKey = stByKey;

  const maxIntensityHour = d3.max(st, d => d.intensity_hour) || 1;
  window.maxIntensityHour = maxIntensityHour;

  const hotColor = d3.scaleQuantize()
    .domain([0, maxIntensityHour])
    .range(d3.schemeYlOrRd[7].slice(1));
  window.hotColor = hotColor;

  // -------------------------------------------
  // 5. OD borough highlight palette (used by odmap.js)
  // -------------------------------------------
  const BOROUGH_HIGHLIGHT = {
    "Manhattan": "rgba(81, 169, 81, 0.30)",
    "Brooklyn": "rgba(81, 169, 81, 0.30)",
    "Queens": "rgba(81, 169, 81, 0.30)",
    "The Bronx": "rgba(81, 169, 81, 0.30)",
    "Staten Island": "rgba(81, 169, 81, 0.30)",
    "Unknown": "rgba(81, 169, 81, 0.20)"
  };
  const BOROUGH_KEYS = [
    "manhattan",
    "brooklyn",
    "queens",
    "the bronx",
    "staten island"
  ];
  window.BOROUGH_HIGHLIGHT = BOROUGH_HIGHLIGHT;
  window.BOROUGH_KEYS = BOROUGH_KEYS;

  // -------------------------------------------
  // 6. Flows cleanup (shared expectations)
  // -------------------------------------------
  flows.forEach(d => {
    d.origin_zone = +d.origin_zone;
    d.destination_zone = +d.destination_zone;
    d.time_bin = +d.time_bin;
    d.trip_count = +d.trip_count;

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

  // -------------------------------------------
  // 7. Zone degree caps (for OD view readability)
  // -------------------------------------------
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
  const top5 = Math.ceil(nZones * 0.05);
  const top10 = Math.ceil(nZones * 0.10);
  const top20 = Math.ceil(nZones * 0.20);
  const top40 = Math.ceil(nZones * 0.40);

  const zoneCapMap = new Map();
  connectivityArray.forEach((entry, idx) => {
    let cap = 20;
    if (idx < top5) cap = 50;
    else if (idx < top10) cap = 40;
    else if (idx < top20) cap = 30;
    else if (idx < top40) cap = 20;
    zoneCapMap.set(entry.id, cap);
  });
  window.zoneCapMap = zoneCapMap;

  // Helper to expose borough lookup to hotmap/odmap
  function getZoneBoroughById(id) {
    const info = idTo.get(id);
    return info ? info.borough : "Unknown";
  }
  window.getZoneBoroughById = getZoneBoroughById;

  // -------------------------------------------
  // 8. Initialize the four big chunks of the UI
  // -------------------------------------------

  if (typeof window.initHotMap === "function") {
    window.initHotMap();
  }

  if (typeof window.initHotmapState === "function") {
    window.initHotmapState();
  }

  if (typeof window.initODMap === "function") {
    window.initODMap();
  }

  if (typeof window.initCorridors === "function") {
    window.initCorridors();
  }

  if (typeof window.initClustersView === "function") {
    window.initClustersView();
  }

  // -------------------------------------------
  // 9. Hour slider behavior
  // -------------------------------------------
  if (hourEl) {
    hourEl.addEventListener("input", () => {
      const h = +hourEl.value;
      hourLabel.textContent = fmtHour(h);

      if (typeof window.repaintHot === "function") {
        window.repaintHot();
      }
      if (typeof window.paintOdNodesFromHot === "function") {
        window.paintOdNodesFromHot();
      }
      if (typeof window.selectedPrimary !== "undefined" &&
        window.selectedPrimary !== null &&
        typeof window.renderODForPrimary === "function") {
        window.renderODForPrimary();
      }
      if (typeof window.applyBoroughFilter === "function") {
        window.applyBoroughFilter();
      }
      if (window.clusterTimeViewActive &&
        window.activeTimeClusterId != null &&
        typeof window.highlightZonesForTimeCluster === "function") {
        window.highlightZonesForTimeCluster(window.activeTimeClusterId);
      }
    });
  }

  // -------------------------------------------
  // 10. OD / Cluster view toggle buttons
  // -------------------------------------------
  const odMapWrap = document.getElementById("odMap");
  const clusterView = document.getElementById("clusterView");
  const odControls = document.querySelector(".od-controls");
  const odCorrControls = document.getElementById("odCorridorControls");
  const odSummaryEl = document.getElementById("odSummary");
  const odDbgEl = document.getElementById("odDbg");

  document.querySelectorAll(".od-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      // toggle active tab button
      document.querySelectorAll(".od-view-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");

      const view = btn.dataset.view;  // "od" or "cluster"

      if (view === "od") {
        window.clusterTimeViewActive = false;
        window.activeTimeClusterId = null;   // clear any cluster selection

        // OD flow view ON
        if (odMapWrap) odMapWrap.style.display = "";
        if (clusterView) clusterView.style.display = "none";
        if (odControls) odControls.style.display = "flex";
        if (odCorrControls) odCorrControls.style.display = "";
        if (odSummaryEl) odSummaryEl.style.display = "";
        if (odDbgEl) odDbgEl.style.display = "";

        if (odPanelTitle) odPanelTitle.textContent = OD_TITLE_TEXT;
        if (odPanelSubtitle) odPanelSubtitle.innerHTML = OD_SUBTITLE_TEXT;

        if (typeof window.repaintHot === "function") {
          window.repaintHot();
        }

      } else {
        window.clusterTimeViewActive = true;
        window.activeTimeClusterId = null;   // start with no area highlighted

        // Cluster time-series view ON
        if (odMapWrap) odMapWrap.style.display = "none";
        if (clusterView) clusterView.style.display = "flex";
        if (odControls) odControls.style.display = "none";
        if (odCorrControls) odCorrControls.style.display = "none";
        if (odSummaryEl) odSummaryEl.style.display = "none";
        if (odDbgEl) odDbgEl.style.display = "none";

        if (odPanelTitle) odPanelTitle.textContent = CLUSTER_TITLE_TEXT;
        if (odPanelSubtitle) odPanelSubtitle.textContent = CLUSTER_SUBTITLE_TEXT;

        // Just make sure the chart/table is drawn; map stays neutral until row click
        if (typeof window.refreshClusterDetailForCurrent === "function") {
          window.refreshClusterDetailForCurrent();
        }
        if (typeof window.repaintHot === "function") {
          window.repaintHot();
        }
      }
    });
  });

  // -------------------------------------------
  // 11. Initial UI state
  // -------------------------------------------
  hourLabel.textContent = fmtHour(+hourEl.value);

  if (typeof window.repaintHot === "function") {
    window.repaintHot();
  }
  if (typeof window.paintOdNodesFromHot === "function") {
    window.paintOdNodesFromHot();
  }
  if (typeof window.applyBoroughFilter === "function") {
    window.applyBoroughFilter();
  }
})();