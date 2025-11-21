// ===== Cluster time-series view (right panel, "Cluster time patterns") =====

// Build a small derived structure if data exists
let clusterById = new Map();
let clusterTopList = [];   // now becomes a list of AREA entries

/**
 * Build derived structures from tsData:
 * - clusterById: cluster_id -> rows
 * - clusterTopList: top areas (group of clusters) by total trips (top 10)
 */
function buildClusterStructures() {
  if (!tsData || !tsData.length) return;

  // Normalize schema so this works with both:
  //  - old: { cluster_id, time_bin, trip_count }
  //  - new: { cluster, hour, trip_count, ... }
  tsData.forEach(d => {
    const cid = (d.cluster !== undefined && d.cluster !== null)
      ? d.cluster
      : d.cluster_id;

    const h = (d.hour !== undefined && d.hour !== null)
      ? d.hour
      : d.time_bin;

    d.cluster_id = +cid;
    d.time_bin   = +h;
    d.trip_count = +d.trip_count;
  });

  // group by cluster_id so we can reuse this later
  clusterById = d3.group(tsData, d => d.cluster_id);

  // Build AREA groups: areaKey -> { areaKey, total_trip, clusters:Set, topClusterId, topClusterTrips }
  const areaMap = new Map();

  clusterById.forEach((rows, cluster_id) => {
    // Skip DBSCAN noise cluster
    if (cluster_id < 0) return;

    const areaKey = getAreaKeyForCluster(cluster_id);
    const clusterTrips = d3.sum(rows, r => r.trip_count);

    if (!areaMap.has(areaKey)) {
      areaMap.set(areaKey, {
        areaKey,
        total_trip: 0,
        clusters: new Set(),
        topClusterId: cluster_id,
        topClusterTrips: clusterTrips
      });
    }

    const entry = areaMap.get(areaKey);
    entry.total_trip += clusterTrips;
    entry.clusters.add(cluster_id);

    // Keep track of a representative cluster for this area (used by map highlight, etc.)
    if (clusterTrips > entry.topClusterTrips) {
      entry.topClusterTrips = clusterTrips;
      entry.topClusterId = cluster_id;
    }
  });

  // totals per area, sorted by total trips
  const totals = Array.from(areaMap.values())
    .sort((a, b) => d3.descending(a.total_trip, b.total_trip));

  // top 10 AREAS for the table
  clusterTopList = totals.slice(0, 10);
}

/**
 * Create a human-readable label for a flow/cluster id.
 * Uses cluster_semantics.json when available.
 * Shared by OD view + corridors + cluster view.
 */
function readableClusterLabel(clusterId) {
  if (!semantics) return `Cluster ${clusterId}`;

  const key = String(clusterId);
  const info = semantics[key];

  if (!info) {
    return `Cluster ${clusterId}`;
  }

  // Prefer the short corridor label created by the Python script,
  //   e.g. "Midtown ↔ JFK"
  if (info.label) {
    const rawLabel = info.label;
    const parts = rawLabel.split("↔");
    if (parts.length === 2) {
      const left = parts[0].trim();
      const right = parts[1].trim();
      if (left && right && left.toLowerCase() === right.toLowerCase()) {
        // Same area on both sides → show as "Intra Upper East Side"
        return `Intra ${left}`;
      }
    }
    return rawLabel;
  }

  // Final fallback
  return `Cluster ${clusterId}`;
}

/**
 * Time-series version: label for spatiotemporal zone clusters.
 * Uses cluster_semantics_t.json (exposed as window.semanticsTime).
 * - Prefer info.label (area alias)
 * - Append the top zone name if it's meaningfully different
 * - Strip any trailing "(...)" suffix (AM peak, Late night, etc.).
 */
function readableTimeClusterLabel(clusterId) {
  const dict = (typeof semanticsTime !== "undefined" && semanticsTime) ? semanticsTime : {};
  const key = String(clusterId);
  const info = dict[key];

  if (!info) {
    return `Cluster ${clusterId}`;
  }

  // Remove any " ( ... )" at the END of the string, regardless of contents.
  function stripParenSuffix(s) {
    if (!s) return s;
    return String(s).replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  // Base label from semantics 
  const rawBase = info.label || `Cluster ${clusterId}`;
  const base = stripParenSuffix(rawBase);

  // First top zone name, if present
  const topZones = Array.isArray(info.top_zones) ? info.top_zones : [];
  const primaryZoneRaw = topZones.length ? topZones[0] : null;
  const primaryZone = primaryZoneRaw ? stripParenSuffix(primaryZoneRaw) : null;

  // If no top zone, return the base alias
  if (!primaryZone) {
    return base;
  }

  // Normalize for comparison
  const baseNorm = base.toLowerCase();
  const zoneNorm = primaryZone.toLowerCase();

  if (baseNorm && zoneNorm && (baseNorm.includes(zoneNorm) || zoneNorm.includes(baseNorm))) {
    return base;
  }
  return `${base} — ${primaryZone}`;
}

/**
 * Get an area-level key for a time cluster.
 * Use semanticsTime[label] and strip any "(AM peak)", "(Late night)", etc.
 * So multiple time-window clusters for "LaGuardia – LaGuardia Airport"
 * collapse into the same areaKey.
 */
function getAreaKeyForCluster(clusterId) {
  const dict = (typeof semanticsTime !== "undefined" && semanticsTime) ? semanticsTime : {};
  const info = dict[String(clusterId)];
  if (!info || !info.label) {
    return `Cluster ${clusterId}`;
  }
  // strip trailing " ( ... )"
  return String(info.label).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Render the top-N AREAS into the table (#clusterTable).
 */
function renderClusterTable() {
  const tbody = d3.select("#clusterTable tbody");
  tbody.selectAll("tr").remove();

  const rows = tbody.selectAll("tr")
    .data(clusterTopList)
    .enter()
    .append("tr")
    .attr("data-area", d => d.areaKey)
    .on("click", (event, d) => {
      renderClusterDetail(d);
      highlightClusterRow(d.areaKey);

      // For map highlighting, we use the representative cluster id
      if (typeof window.setActiveTimeClusterOnMap === "function") {
        window.setActiveTimeClusterOnMap(d.topClusterId);
      }

      // Expose active area
      window.activeTimeClusterArea = d;
    });

  const cellPadding = "6px 4px";

  rows.append("td")
    .style("padding", cellPadding)
    .text((d, i) => i + 1);

  rows.append("td")
    .style("padding", cellPadding)
    .text(d => d.areaKey); 

  rows.append("td")
    .style("padding", cellPadding)
    .style("text-align", "right")
    .text(d => d3.format(",")(d.total_trip));

  // Initial layout when table first rendered
  layoutClusterTable();
}

function layoutClusterTable() {
  const wrap  = document.querySelector(".cluster-table-wrap");
  const table = document.getElementById("clusterTable");
  if (!wrap || !table) return;

  const tbody = table.querySelector("tbody");
  const rows  = tbody ? Array.from(tbody.querySelectorAll("tr")) : [];
  if (!rows.length) return;

  const wrapRect   = wrap.getBoundingClientRect();
  const thead      = table.querySelector("thead");
  const headerRect = thead ? thead.getBoundingClientRect() : { height: 0 };

  // Available height inside wrapper for body rows
  const available = Math.max(
    0,
    wrapRect.height - headerRect.height - 8  // a tiny buffer
  );

  const minRowHeight = 28; // don't get too squished
  const targetHeight = Math.max(minRowHeight, available / rows.length);

  rows.forEach(tr => {
    tr.style.height = targetHeight + "px";
  });
}

/**
 * Highlight the active AREA row in the table.
 */
function highlightClusterRow(areaKey) {
  d3.selectAll("#clusterTable tbody tr").classed("active", false);
  d3.select(`#clusterTable tbody tr[data-area='${areaKey.replace(/'/g, "\\'")}']`)
    .classed("active", true);
}

function renderClusterDetail(areaEntry) {
  if (!areaEntry || !areaEntry.clusters) return;

  // Collect all rows from all clusters in this area
  const allRows = [];
  areaEntry.clusters.forEach(cid => {
    const rows = clusterById.get(cid);
    if (rows && rows.length) {
      allRows.push(...rows);
    }
  });

  // aggregate by hour (time_bin)
  const grouped = d3.rollups(
    allRows,
    v => d3.sum(v, d => d.trip_count),
    d => d.time_bin
  ).map(([time_bin, trip_count]) => ({
    time_bin: +time_bin,
    trip_count: +trip_count
  }));

  // Ensure we have a point for every hour 0–23 so the line spans full width
  const allHours = d3.range(24);
  const series = allHours.map(h => {
    const found = grouped.find(d => d.time_bin === h);
    return {
      time_bin: h,
      trip_count: found ? found.trip_count : 0
    };
  });

  const box = d3.select("#clusterDetail");
  box.selectAll("*").remove();

  // Slightly tighter margins so the line feels more full-bleed
  const margin = { top: 16, right: 26, bottom: 40, left: 78 };

  const node = box.node();
  const width =
    (node && node.getBoundingClientRect().width) ||
    (node && node.clientWidth) ||
    600;

  const height = 250;
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const svg = box.append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const yMax = d3.max(series, d => d.trip_count) || 1;

  const x = d3.scaleLinear()
    .domain([0, 23])
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, yMax])
    .nice()
    .range([innerH, 0]);

  const line = d3.line()
    .x(d => x(d.time_bin))
    .y(d => y(d.trip_count));

  // main line
  g.append("path")
    .datum(series)
    .attr("fill", "none")
    .attr("stroke", "#3b82f6")
    .attr("stroke-width", 2)
    .attr("d", line);

  // Axes 
  const xAxis = d3.axisBottom(x).ticks(12);
  const yAxis = d3.axisLeft(y).ticks(4).tickFormat(d3.format(","));

  g.append("g")
    .attr("class", "x-axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(xAxis);

  g.append("g")
    .attr("class", "y-axis")
    .call(yAxis);

  g.selectAll(".x-axis text, .y-axis text")
    .attr("fill", "#64748b")
    .attr("font-size", 11)
    .attr("font-family", "system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif");

  g.selectAll(".x-axis path, .x-axis line, .y-axis path, .y-axis line")
    .attr("stroke", "#cbd5e1")
    .attr("stroke-width", 1);

  const axisLabelColor = "#475569";
  const axisLabelSize  = 10;
  const yLabelGap      = 18;

  g.append("text")
    .attr("x", innerW / 2)
    .attr("y", innerH + 36)
    .attr("text-anchor", "middle")
    .attr("fill", axisLabelColor)
    .attr("font-size", axisLabelSize)
    .text("Hour of day");

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerH / 2)
    .attr("y", -(margin.left - yLabelGap))
    .attr("text-anchor", "middle")
    .attr("fill", axisLabelColor)
    .attr("font-size", axisLabelSize)
    .text("Trip count");

  // --- Red (peak) & green (min) dots ---
  if (series.length > 0) {
    const peakPoint = series.reduce(
      (best, d) => (d.trip_count > best.trip_count ? d : best),
      series[0]
    );
    const lowPoint = series.reduce(
      (best, d) => (d.trip_count < best.trip_count ? d : best),
      series[0]
    );

    g.append("circle")
      .attr("cx", x(peakPoint.time_bin))
      .attr("cy", y(peakPoint.trip_count))
      .attr("r", 4.5)
      .attr("fill", "#ef4444"); // red

    g.append("circle")
      .attr("cx", x(lowPoint.time_bin))
      .attr("cy", y(lowPoint.trip_count))
      .attr("r", 4.5)
      .attr("fill", "#22c55e"); // green
  }

  // tooltip + hover (unchanged, just change the label it uses)
  const tooltip = d3.select("#clusterTooltip");

  tooltip
    .style("position", "fixed")
    .style("pointer-events", "none")
    .style("background", "#ffffff")
    .style("color", "#0f172a")
    .style("padding", "6px 8px")
    .style("border-radius", "6px")
    .style("font-size", "11px")
    .style("box-shadow", "0 4px 12px rgba(15,23,42,0.16)")
    .style("border", "1px solid rgba(148,163,184,0.7)")
    .style("display", "none");

  const hoverLine = g.append("line")
    .attr("y1", 0)
    .attr("y2", innerH)
    .attr("stroke", "#94a3b8")
    .attr("stroke-width", 1)
    .style("opacity", 0);

  const hoverCircle = g.append("circle")
    .attr("r", 4)
    .attr("fill", "#3b82f6")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("opacity", 0);

  const clusterLabel = areaEntry.areaKey;

  g.append("rect")
    .attr("width", innerW)
    .attr("height", innerH)
    .attr("fill", "transparent")
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const hour = Math.round(x.invert(mx));
      const pt = series.find(d => d.time_bin === hour);
      if (!pt) return;

      const cx = x(pt.time_bin);
      const cy = y(pt.trip_count);

      hoverLine
        .attr("x1", cx)
        .attr("x2", cx)
        .style("opacity", 1);

      hoverCircle
        .attr("cx", cx)
        .attr("cy", cy)
        .style("opacity", 1);

      const rect = box.node().getBoundingClientRect();
      const hourLabel = pt.time_bin.toString().padStart(2, "0") + ":00";

      tooltip
        .style("display", "block")
        .html(
          `<div style="font-weight:600;margin-bottom:2px;">${clusterLabel}</div>` +
          `<div>Hour: <b>${hourLabel}</b></div>` +
          `<div>Trips: <b>${d3.format(",")(pt.trip_count)}</b></div>`
        );

      const tipRect   = tooltip.node().getBoundingClientRect();
      const viewportW = window.innerWidth || document.documentElement.clientWidth;

      const rightX = rect.left + margin.left + cx + 12;
      const yPos   = rect.top + margin.top + cy - 10;

      let finalX = rightX;
      if (rightX + tipRect.width + 8 > viewportW) {
        finalX = rect.left + margin.left + cx - tipRect.width - 12;
      }

      tooltip
        .style("left", finalX + "px")
        .style("top",  yPos + "px");
    })
    .on("mouseleave", () => {
      hoverLine.style("opacity", 0);
      hoverCircle.style("opacity", 0);
      tooltip.style("display", "none");
    });

  // title above the chart
  d3.select("#clusterDetailTitle")
    .text(clusterLabel);
}

/**
 * Entry point for the cluster view.
 * Call this once after tsData + semantics are loaded.
 */
function initClustersView() {
  buildClusterStructures();

  // Just ensure the chart container can expand; no flex gymnastics
  const clusterDetailEl = document.getElementById("clusterDetail");
  if (clusterDetailEl) {
    clusterDetailEl.style.width = "100%";
  }

  if (clusterTopList.length) {
    renderClusterTable();
    // DO NOT call renderClusterDetail here
    // highlightClusterRow is also not needed yet
  }
}

function refreshClusterDetailForCurrent() {
  const activeRow = d3.select("#clusterTable tbody tr.active");
  let datum = activeRow.empty() ? null : activeRow.datum();

  if (!datum && clusterTopList.length) {
    datum = clusterTopList[0];
  }
  if (!datum) return;

  renderClusterDetail(datum);
  highlightClusterRow(datum.areaKey);

  layoutClusterTable();
}

function getTopTimeClusterIds() {
  // Return representative cluster ids for top areas
  return clusterTopList.map(d => d.topClusterId);
}

// expose for other modules (hotmap.js)
window.getTopTimeClusterIds = getTopTimeClusterIds;

// Expose cluster view entry points to wiring.js
window.initClustersView = initClustersView;   // if you created one

window.buildClusterStructures = buildClusterStructures;
window.renderClusterTable = renderClusterTable;
window.renderClusterDetail = renderClusterDetail;
window.highlightClusterRow = highlightClusterRow;
window.readableClusterLabel = readableClusterLabel;
window.readableTimeClusterLabel = readableTimeClusterLabel;
window.refreshClusterDetailForCurrent = refreshClusterDetailForCurrent;
window.layoutClusterTable = layoutClusterTable;