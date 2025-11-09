# NYC Taxi Data Visualization

This current repo is a very lightweight prototype of three D3-based visualizations for NYC taxi data. If you clone it and run a simple local web server, it should work out of the box with the sample data in `data/`.

It’s intentionally simple — you are **highly encouraged** to expand it (more interactions, filters, styling, new datasets), **but please don’t push directly to `main`**. Create your own branch and open a PR.

## Repo Structure

```text
.
├── data
│   ├── cluster_semantics.json
│   ├── clusters_spatiotemporal.csv
│   ├── flows.csv
│   ├── taxi_zone_lookup.csv
│   ├── taxi_zones.geojson
│   └── timeseries.csv
├── flows.html
├── map.html
├── README.md
└── timeseries.html

### What each part is

* **`data/`** — all the backing data files the HTML pages fetch via D3.

  * `taxi_zones.geojson` — NYC TLC zone boundaries (polygons) with `LocationID`, `Zone`, `Borough`.
  * `taxi_zone_lookup.csv` — lookup table to turn `LocationID` into human-readable zone/borough names.
  * `flows.csv` — zone-to-zone trip flows by hour.
  * `clusters_spatiotemporal.csv` — output from a spatiotemporal clustering step (per zone, per hour stats).
  * `timeseries.csv` — per-cluster, per-hour time series (used in the line chart dashboard).
  * `cluster_semantics.json` — optional metadata to make cluster names nicer (e.g. show “JFK – Queens” instead of “Cluster 7”).

* **`flows.html`** — interactive zone-to-zone flow view.

* **`map.html`** — choropleth-style map showing spatiotemporal hotspot/clustering by hour.

* **`timeseries.html`** — dashboard-style page showing time-of-day patterns for the top clusters.

## What each HTML needs

### 1. `flows.html`

An interactive map where you click a zone and see its connections.

**Requires:**

* `data/taxi_zones.geojson`
* `data/flows.csv`
* `data/taxi_zone_lookup.csv` *(used to show nicer names; if missing, it should still work but with blander labels)*

**What it does:**

* Draws NYC taxi zones.
* Plots zone centroids as clickable nodes.
* On click: draws curved edges to connected zones for the selected hour.
* Lets you filter by borough.

### 2. `map.html`

A time-weighted / spatiotemporal cluster choropleth.

**Requires:**

* `data/taxi_zones.geojson`
* `data/clusters_spatiotemporal.csv`

**What it does:**

* Fits the NYC zones to the SVG.
* For a selected hour (slider 0–23), fills each zone based on `intensity_hour`.
* Uses `cluster_id` to style noise (e.g. red stroke for `-1`).
* Shows a small legend with min/mid/max for that hour’s scale.

**Expected columns in `clusters_spatiotemporal.csv`:**

* `LocationID`
* `hour`
* `cluster_id`
* `intensity_hour`
* (optionally) `avg_fare_hour`, `avg_duration_min_hour`

### 3. `timeseries.html`

A small “top 10 clusters” dashboard with a line chart.

**Requires:**

* `data/timeseries.csv`
* `data/cluster_semantics.json` *(optional, for prettier labels)*

**What it does:**

* Loads all rows, groups by `cluster_id`.
* Ranks clusters by total trips and shows the top 10 in a table.
* When you click a cluster, it draws the 24-hour line for that cluster.
* If `cluster_semantics.json` exists, it uses it to show nicer titles and top zones.

**Expected columns in `timeseries.csv`:**

* `cluster_id`
* `time_bin` (0–23)
* `trip_count`

## How to Run Locally

Because the HTML files use `d3.csv(...)` / `d3.json(...)`, you should serve the folder, not open the HTML with `file://`.

From the project root:

```bash
python -m http.server 8000
```

Then open in your browser:

* [http://127.0.0.1:8000/flows.html](http://127.0.0.1:8000/flows.html)
* [http://127.0.0.1:8000/map.html](http://127.0.0.1:8000/map.html)
* [http://127.0.0.1:8000/timeseries.html](http://127.0.0.1:8000/timeseries.html)

## Contributing

1. **Create a new branch** — don’t push straight to `main`:

   ```bash
   git checkout -b feature/my-improvement
   ```
2. Make your changes (new filters, better legends, new datasets).
3. Commit and open a PR.

Ideas to improve:

* Add date / month filters
* Add OD volume histograms
* Add tooltips showing both in- and out-flows
* Make the color scale dynamic to the selected subset

## Notes

* This is a **prototype**: structure is flat on purpose.
* Data files are small and included directly to make it easy to clone and run.
* If you change filenames in `data/`, make sure to update the corresponding `.html` file where `d3.csv(...)` or `d3.json(...)` is called.
