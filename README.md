# NYC Taxi Data Visualization

## DESCRIPTION

This project provides an interactive, browser-based dashboard for exploring mobility patterns in NYC taxi data. It brings together three linked D3.js visual components: an hourly hotspot map that visualizes pickup intensity across taxi zones, an origin–destination flow explorer that highlights major travel corridors between neighborhoods, and a time-series panel that summarizes 24-hour activity patterns for spatiotemporal clusters. These coordinated views allow users to analyze how pickup density, travel flows, and neighborhood-level rhythms evolve throughout the day.
All computations run entirely client-side in lightweight HTML/JS using pre-aggregated datasets, making the dashboard fast, self-contained, and easy to run without any backend services or additional software.

## INSTALLATION

Installation is minimal. Simply download or unzip the project folder to your machine. As long as Python is installed (any recent version works), no other libraries or frameworks are required. All data loading and visualization logic happens directly in the browser.

## EXECUTION

To run the dashboard:

1. Open a terminal in the project directory.

2. Start a lightweight local web server:

   ```bash
   python -m http.server 8000
   ```

3. In your browser, open:

   **[http://127.0.0.1:8000/index.html](http://127.0.0.1:8000/index.html)**

This launches the full integrated dashboard with all three coordinated views. You can also explore simpler standalone prototypes located in the **Baseline Viz** folder, which include separate versions of the hotspot map, OD-flow explorer, and time-series visualization. No additional setup is required.


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
│   ├── cluster_semantics_t.json
│   ├── cluster_semantics.json
│   ├── cluster_timeseries.csv
│   ├── clusters_spatiotemporal.csv
│   ├── daily_zone_hour.parquet
│   ├── flows.csv
│   ├── taxi_zone_lookup.csv
│   ├── taxi_zones.geojson
│   ├── zone_centroids.geojson
│   ├── zone_hour_clusters.parquet
│   └── zone_hour_density.parquet
├── data script
│   ├── build_flow_cluster_semantics.py
│   ├── build_zone_cluster_semantics.py
│   ├── build_zone_hour_clusters.py
│   ├── clean.py
│   ├── cluster_timeseries.py
│   ├── compute_clusters.py
│   └── compute_flow.py
├── index.html
├── js
│   ├── clusters.js
│   ├── corridors.js
│   ├── hotmap.js
│   ├── odmap.js
│   ├── state.js
│   └── wiring.js
├── README.md
└── Three Questions For Viz Design.pdf
```

# Visual Files — Description Table

| File                | Description                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **index.html**      | Main dashboard interface combining the hotspot map, OD map, and cluster time-series panel; loads scripts, defines layout, and initializes all visual components. |
| **css/main.css**    | Global styling for layout, maps, legends, tooltips, controls, and panels; ensures consistent and responsive formatting.                                          |
| **js/clusters.js**  | Implements the cluster time-series view, draws 24-hour activity curves, ranks top clusters, and synchronizes map–timeseries interactions.                        |
| **js/corridors.js** | Handles corridor search logic, alias normalization, borough inference, and mapping text queries to canonical corridor keys.                                      |
| **js/hotmap.js**    | Renders the hotspot/choropleth map with hourly intensity coloring, zoom behavior, hover states, and cross-linked selections.                                     |
| **js/odmap.js**     | Renders the OD flow map with polygons, centroids, arcs, corridor filtering, tooltips, and zoom/selection behavior.                                               |
| **js/state.js**     | Defines the shared global application state, including selected zones, corridors, hover states, and utility normalization helpers.                               |
| **js/wiring.js**    | Loads datasets, builds global lookups, initializes all views, connects UI controls, and coordinates inter-module communication.                                  |

# Data Script Files — Description Table

| File                                            | Description                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **data script/clean.py**                        | Cleans raw FHVHV trips and creates zone-hour density tables and a sampled-trips file for downstream analysis.               |
| **data script/compute_clusters.py**             | Computes spatial and spatiotemporal DBSCAN clusters for zones and zone-hours, generating cluster labels and zone centroids. |
| **data script/compute_flow.py**                 | Aggregates trips into OD flows and clusters them into corridor-style flow groups using direction and distance features.     |
| **data script/build_zone_hour_clusters.py**     | Merges spatiotemporal cluster labels with the full zone-hour universe to produce a unified cluster mapping.                 |
| **data script/cluster_timeseries.py**           | Builds cluster-level time series and computes stability metrics such as DTW, autocorrelation, and SNR.                      |
| **data script/build_flow_cluster_semantics.py** | Generates human-readable labels for flow clusters (e.g., “Midtown ↔ JFK”) using alias rules and zone lookups.               |
| **data script/build_zone_cluster_semantics.py** | Produces semantic summaries for zone-hour clusters, assigning area names and time-of-day categories.                        |

## Views and Data Dependencies

### Integrated Dashboard — `index.html`

Requires:

* `taxi_zones.geojson`
* `taxi_zone_lookup.csv`
* `flows.csv`
* `clusters_spatiotemporal.csv`
* `cluster_timeseries.csv`
* Optional: `cluster_semantics.json`, `cluster_semantics_t.json`

### Baseline Prototypes

* **flows.html** — uses zones, flows, lookup
* **map.html** — uses zones, spatiotemporal clusters
* **timeseries.html** — uses cluster timeseries + semantics
