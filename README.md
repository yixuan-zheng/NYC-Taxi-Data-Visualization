# NYC Taxi Data Visualization

This repo is a lightweight prototype of three D3-based visualizations for NYC taxi data, plus a new integrated dashboard.  
If you clone it and run a simple local web server, it should work out of the box with the sample data in `data/`.

It’s intentionally simple — you are **highly encouraged** to expand it (more interactions, filters, styling, new datasets), **but please don’t push directly to `main`**. Create your own branch and open a PR.

## Repo Structure

```text
.
├── Baseline Viz
│   ├── flows.html
│   ├── map.html
│   └── timeseries.html
├── css
│   └── main.css
├── data
│   ├── cluster_semantics.json
│   ├── cluster_semantics_t.json
│   ├── clusters_spatiotemporal.csv
│   ├── flows.csv
│   ├── taxi_zone_lookup.csv
│   ├── taxi_zones.geojson
│   └── timeseries.csv
├── js
│   ├── clusters.js
│   ├── corridors.js
│   ├── hotmap.js
│   ├── odmap.js
│   ├── state.js
│   └── wiring.js
├── index.html
├── .gitignore
├── README.md
└── Three Questions For Viz Design.pdf
```

### What each part is

* **`data/`** — all the backing data files the HTML pages fetch via D3.

  * `taxi_zones.geojson` — NYC TLC zone boundaries (polygons) with `LocationID`, `Zone`, `Borough`.
  * `taxi_zone_lookup.csv` — lookup table to turn `LocationID` into human-readable zone/borough names.
  * `flows.csv` — zone-to-zone trip flows by hour.
  * `clusters_spatiotemporal.csv` — output from a spatiotemporal clustering step (per zone, per hour stats).
  * `timeseries.csv` — per-cluster, per-hour time series (used in the line chart dashboard).
  * `cluster_semantics.json` — optional metadata to make cluster names nicer (e.g. show “JFK – Queens” instead of “Cluster 7”).

* **`css/main.css`** — shared styling for the integrated dashboard.

* **`js/`** — modular JavaScript for the new dashboard:
  * `hotmap.js` — hourly hotspot / choropleth map.
  * `odmap.js` — OD flow map (zone-to-zone links).
  * `cluster.js` — cluster list + time-series wiring.
  * `corridors.js` — helpers for OD “corridor” summaries.
  * `state.js` — shared UI state (selected hour, cluster, filters, etc.).
  * `wiring.js` — boots the app and connects UI controls to the modules.

* **`Baseline Viz/`** — original standalone prototype HTMLs:
  * `flows.html` — baseline zone-to-zone flow view.
  * `map.html` — baseline hotspot / cluster choropleth.
  * `timeseries.html` — baseline time-series dashboard.
 
* **`Three Questions For Viz Design.pdf`** — design brief / reading for the project.

## Views and data dependencies

### 1. Integrated dashboard `index.html`

A single page with three linked views: hourly hotspot map, OD flow explorer, and cluster time-series panel.

**Requires:**

* `data/taxi_zones.geojson`
* `data/taxi_zone_lookup.csv`
* `data/flows.csv`
* `data/clusters_spatiotemporal.csv`
* `data/timeseries.csv`
* `data/cluster_semantics.csv`

**What it does:**

* Shows hourly hotspots as a choropleth over NYC taxi zones.
* Lets you explore OD flows between zones for the selected hour.
* Lists clusters and shows the 24-hour pattern for a selected cluster.
* Shares filters (e.g., hour, selected cluster/zone) across all three views.

### 2. Baseline prototypes (`Baseline Viz/*.html`)

Simpler, stand-alone versions of each view. They are useful for debugging or comparing against the integrated dashboard.

- **`Baseline Viz/flows.html`** — interactive OD flow map.
  - **Requires:**
    - `data/taxi_zones.geojson`
    - `data/flows.csv`
    - `data/taxi_zone_lookup.csv` *(used to show nicer names; if missing, labels fall back to IDs)*

- **`Baseline Viz/map.html`** — time-weighted / spatiotemporal cluster choropleth.
  - **Requires:**
    - `data/taxi_zones.geojson`
    - `data/clusters_spatiotemporal.csv`
  - **Expected columns in `clusters_spatiotemporal.csv`:**
    - `LocationID`
    - `hour`
    - `cluster_id`
    - `intensity_hour`
    - *(optionally)* `avg_fare_hour`, `avg_duration_min_hour`

- **`Baseline Viz/timeseries.html`** — simple “top clusters” time-series view.
  - **Requires:**
    - `data/timeseries.csv`
    - `data/cluster_semantics.json` *(optional)*
  - **Expected columns in `timeseries.csv`:**
    - `cluster_id`
    - `time_bin` (0–23)
    - `trip_count`
      
## How to Run Locally

Because the HTML files use `d3.csv(...)` / `d3.json(...)`, you should serve the folder, not open the HTML with `file://`.

From the project root:

```bash
python -m http.server 8000
```

Then open in your browser:

- **Main dashboard:**
  - [http://127.0.0.1:8000/index.html](http://127.0.0.1:8000/index.html)

- **Baseline prototypes (optional):**
  - [http://127.0.0.1:8000/Baseline%20Viz/flows.html](http://127.0.0.1:8000/Baseline%20Viz/flows.html)
  - [http://127.0.0.1:8000/Baseline%20Viz/map.html](http://127.0.0.1:8000/Baseline%20Viz/map.html)
  - [http://127.0.0.1:8000/Baseline%20Viz/timeseries.html](http://127.0.0.1:8000/Baseline%20Viz/timeseries.html)

## Contributing

1. **Create a new branch** — don’t push straight to `main`:

   ```bash
   git checkout -b feature/my-improvement
   ```
2. Make your changes (new filters, better legends, new datasets).
3. Commit and open a PR.

## Notes

* This is a **prototype**: structure is flat on purpose.
* Data files are small and included directly to make it easy to clone and run.
* If you change filenames in `data/`, make sure to update the corresponding `.html` file where `d3.csv(...)` or `d3.json(...)` is called.
