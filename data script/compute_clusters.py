# compute_clusters.py
# Produces:
#   data/clusters_spatial.csv
#   data/clusters_spatiotemporal.csv
#   data/zone_centroids.geojson   (helper for debugging/point overlays)

import os
import math
import numpy as np
import pandas as pd

import geopandas as gpd
from shapely.geometry import Point
from sklearn.cluster import DBSCAN
from pyproj import Transformer

ARTIFACTS_DIR = "artifacts"
DATA_DIR      = "data"

ZONE_DENSITY_PARQUET = os.path.join(ARTIFACTS_DIR, "zone_hour_density.parquet")
SAMPLE_TRIPS_PARQUET = os.path.join(ARTIFACTS_DIR, "sample_trips.parquet")
TAXI_ZONES_GEOJSON   = os.path.join(DATA_DIR, "taxi_zones.geojson")  # polygons with LocationID

OUT_SPATIAL_CSV         = os.path.join(DATA_DIR, "clusters_spatial.csv")
OUT_SPATIOTEMPORAL_CSV  = os.path.join(DATA_DIR, "clusters_spatiotemporal.csv")
OUT_ZONE_CENTROIDS_GJ   = os.path.join(DATA_DIR, "zone_centroids.geojson")

# --- DBSCAN hyperparams (tune if needed) ---
# eps in meters (after projecting to EPSG:3857); ~1200–2000m works well for zone centroids
SPATIAL_EPS_METERS = 1600
SPATIAL_MIN_SAMPLES = 5

# Spatiotemporal: build 3D (x_meters, y_meters, t_scaled)
# Scale 1 hour -> meters; makes time comparable to spatial distances.
# If clusters over many hours should merge more, increase this.
TIME_TO_METERS = 1200    # hours less explosive in distance, glue across time more
ST_MIN_SAMPLES = 30      # require a decent number of neighbors
ST_EPS = 3800            # allow clusters to be spatially a bit larger

# Any cluster that eats more than this fraction of all points will be treated
# as "background" and re-labeled as noise (-1) for downstream time-series usage
# IF we cannot find a better eps.
MAX_CLUSTER_FRACTION_FOR_TS = 0.5

# For auto-tuning eps in spatiotemporal DBSCAN
MIN_NON_NOISE_FRACTION = 0.20   # want at least 20% of points in non-noise clusters
MIN_CLUSTERS           = 3
MAX_CLUSTERS           = 40


# -------------------------
# Helpers
# -------------------------
def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)

def webmercator_transformer():
    # WGS84 -> Web Mercator (meters)
    return Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)

def lonlat_to_meters(lon, lat, tfm):
    x, y = tfm.transform(lon, lat)
    return x, y

def safe_mean(series):
    return float(series.mean()) if len(series) else float("nan")


# -------------------------
# Load data
# -------------------------
def load_inputs():
    df_density = pd.read_parquet(ZONE_DENSITY_PARQUET)   # columns: PULocationID, hour, trip_count
    df_trips   = pd.read_parquet(SAMPLE_TRIPS_PARQUET)   # has fares & durations
    gdf_zones  = gpd.read_file(TAXI_ZONES_GEOJSON)       # must include "LocationID" (int) and polygon geometry
    # Normalize schema
    gdf_zones["LocationID"] = gdf_zones["LocationID"].astype(int)
    return df_density, df_trips, gdf_zones


# -------------------------
# Feature engineering
# -------------------------
def compute_zone_centroids(gdf_zones):
    # centroid in lon/lat + projected meters
    gdf = gdf_zones.to_crs("EPSG:4326").copy()
    gdf["centroid_ll"] = gdf.geometry.centroid
    tfm = webmercator_transformer()
    gdf["cx"] = gdf["centroid_ll"].x
    gdf["cy"] = gdf["centroid_ll"].y
    gdf["mx"], gdf["my"] = zip(*gdf.apply(lambda r: lonlat_to_meters(r["cx"], r["cy"], tfm), axis=1))
    return gdf[["LocationID", "cx", "cy", "mx", "my", "geometry"]]


def aggregate_zone_level_stats(df_density, df_trips):
    # Intensity & persistence
    agg_den = df_density.groupby("PULocationID").agg(
        trip_count_total=("trip_count", "sum"),
        persistence_hours=("trip_count", lambda s: (s > 0).sum())
    ).reset_index().rename(columns={"PULocationID": "LocationID"})

    # Avg fare & duration per zone (from sample)
    # "Fare" proxy: base_passenger_fare + tolls + bcf + sales_tax + congestion_surcharge + airport_fee + tips
    fare_cols = ["base_passenger_fare","tolls","bcf","sales_tax","congestion_surcharge","airport_fee","tips"]
    df_trips["fare_total"] = df_trips[fare_cols].sum(axis=1)
    df_trips["duration_min"] = df_trips["trip_time"] / 60.0

    agg_trip_zone = df_trips.groupby("PULocationID").agg(
        avg_fare=("fare_total", "mean"),
        avg_duration_min=("duration_min", "mean")
    ).reset_index().rename(columns={"PULocationID": "LocationID"})

    return agg_den.merge(agg_trip_zone, on="LocationID", how="left")


def aggregate_zone_hour_stats(df_density, df_trips):
    fare_cols = ["base_passenger_fare","tolls","bcf","sales_tax","congestion_surcharge","airport_fee","tips"]
    df_trips["fare_total"] = df_trips[fare_cols].sum(axis=1)
    df_trips["duration_min"] = df_trips["trip_time"] / 60.0
    # need hour; if not present in sample, derive from pickup_datetime
    if "pickup_datetime" in df_trips.columns:
        df_trips["hour"] = pd.to_datetime(df_trips["pickup_datetime"]).dt.hour.astype(int)
    elif "request_datetime" in df_trips.columns:
        df_trips["hour"] = pd.to_datetime(df_trips["request_datetime"]).dt.hour.astype(int)
    else:
        # Fallback: join by density table hours later only
        df_trips["hour"] = np.nan

    # zone-hour fare/duration
    agg_trip_zh = df_trips.dropna(subset=["hour"]).groupby(["PULocationID","hour"]).agg(
        avg_fare_hour=("fare_total","mean"),
        avg_duration_min_hour=("duration_min","mean")
    ).reset_index().rename(columns={"PULocationID":"LocationID"})

    zh = df_density.rename(columns={"PULocationID":"LocationID","trip_count":"intensity_hour"}).copy()
    out = zh.merge(agg_trip_zh, on=["LocationID","hour"], how="left")

    # --- Ensure each (LocationID, hour) appears at most once before clustering ---
    out = out.drop_duplicates(subset=["LocationID","hour"])

    return out  # columns: LocationID, hour, intensity_hour, avg_fare_hour, avg_duration_min_hour


# -------------------------
# Clustering
# -------------------------
def run_spatial_dbscan(zone_stats, centroids):
    df = zone_stats.merge(centroids, on="LocationID", how="inner")
    df = df[df["trip_count_total"] > 0].copy()
    X = df[["mx","my"]].to_numpy()

    # Use total trips as sample_weight to influence core points (weighted DBSCAN concept).
    # sklearn's DBSCAN supports sample_weight for core-point determination (>= v1.4).
    weights = df["trip_count_total"].to_numpy().astype(float)

    model = DBSCAN(
        eps=SPATIAL_EPS_METERS,
        min_samples=SPATIAL_MIN_SAMPLES,
        metric="euclidean",
        algorithm="ball_tree"
    )
    labels = model.fit_predict(X, sample_weight=weights)

    df_out = df[["LocationID","cx","cy"]].copy()
    df_out["cluster_id"] = labels
    df_out["intensity"] = df["trip_count_total"].to_numpy()
    df_out["persistence_hours"] = df["persistence_hours"].to_numpy()
    df_out["avg_fare"] = df["avg_fare"].to_numpy()
    df_out["avg_duration_min"] = df["avg_duration_min"].to_numpy()
    return df_out


def _run_st_dbscan_once(X, weights, eps):
    """
    Helper: run DBSCAN once for a given eps and return (labels, metrics_dict).
    metrics_dict has keys:
        - n_points
        - n_clusters (non-noise)
        - non_noise_fraction
        - largest_cluster_fraction
    """
    model = DBSCAN(
        eps=eps,
        min_samples=ST_MIN_SAMPLES,
        metric="euclidean",
        algorithm="ball_tree"
    )
    labels = model.fit_predict(X, sample_weight=weights)

    n = len(labels)
    if n == 0:
        return labels, {
            "n_points": 0,
            "n_clusters": 0,
            "non_noise_fraction": 0.0,
            "largest_cluster_fraction": 0.0,
        }

    mask_non_noise = labels >= 0
    n_non_noise = int(mask_non_noise.sum())
    non_noise_fraction = n_non_noise / float(n)

    if n_non_noise == 0:
        metrics = {
            "n_points": n,
            "n_clusters": 0,
            "non_noise_fraction": 0.0,
            "largest_cluster_fraction": 0.0,
        }
        return labels, metrics

    unique, counts = np.unique(labels[mask_non_noise], return_counts=True)
    n_clusters = unique.size
    largest_cluster_fraction = counts.max() / float(n)

    metrics = {
        "n_points": n,
        "n_clusters": int(n_clusters),
        "non_noise_fraction": float(non_noise_fraction),
        "largest_cluster_fraction": float(largest_cluster_fraction),
    }
    return labels, metrics


def run_spatiotemporal_dbscan(zone_hour_stats, centroids):
    df = zone_hour_stats.merge(centroids, on="LocationID", how="inner").copy()
    df = df[df["intensity_hour"] > 0].copy()

    # Build 3D features: space (meters) + scaled time
    t_scaled = df["hour"].to_numpy().astype(float) * TIME_TO_METERS
    X = np.column_stack([df["mx"].to_numpy(), df["my"].to_numpy(), t_scaled])
    weights = df["intensity_hour"].to_numpy().astype(float)

    n_points = len(df)
    print(f"[ST-DBSCAN] Total zone-hour points: {n_points}")

    # Candidate eps schedule, starting from the current ST_EPS and going smaller
    # to break up any giant blob into more meaningful clusters.
    candidate_eps = sorted(
        set([
            ST_EPS,
            ST_EPS * 0.85,
            ST_EPS * 0.70,
            ST_EPS * 0.60,
            ST_EPS * 0.50,
            2200.0,
            2000.0,
            1800.0,
            1600.0,
        ]),
        reverse=True
    )

    best_labels = None
    best_metrics = None
    chosen_eps = None

    print("[ST-DBSCAN] Trying eps candidates (meters):", candidate_eps)

    for eps in candidate_eps:
        labels, metrics = _run_st_dbscan_once(X, weights, eps)
        print(
            f"[ST-DBSCAN] eps={eps:.1f}, "
            f"clusters={metrics['n_clusters']}, "
            f"non_noise_frac={metrics['non_noise_fraction']:.3f}, "
            f"largest_cluster_frac={metrics['largest_cluster_fraction']:.3f}"
        )

        # Keep track of the last run in case all candidates "fail"
        best_labels = labels
        best_metrics = metrics
        chosen_eps = eps

        # Acceptance criteria: we want
        #  - at least MIN_NON_NOISE_FRACTION of points in non-noise clusters
        #  - the largest cluster to be <= MAX_CLUSTER_FRACTION_FOR_TS
        #  - a reasonable number of clusters
        if (
            metrics["non_noise_fraction"] >= MIN_NON_NOISE_FRACTION and
            metrics["largest_cluster_fraction"] <= MAX_CLUSTER_FRACTION_FOR_TS and
            MIN_CLUSTERS <= metrics["n_clusters"] <= MAX_CLUSTERS
        ):
            print(f"[ST-DBSCAN] --> Accepted eps={eps:.1f} based on quality criteria.")
            break

    labels_clean = best_labels.copy()
    final_metrics = best_metrics
    print(
        f"[ST-DBSCAN] Final choice: eps={chosen_eps:.1f}, "
        f"clusters={final_metrics['n_clusters']}, "
        f"non_noise_frac={final_metrics['non_noise_fraction']:.3f}, "
        f"largest_cluster_frac={final_metrics['largest_cluster_fraction']:.3f}"
    )

    # Fallback safety: if even the "best" solution still has a giant cluster,
    # we keep your old rule and convert that cluster to noise (-1).
    n = len(labels_clean)
    if n > 0:
        mask_non_noise = labels_clean >= 0
        if mask_non_noise.any():
            unique, counts = np.unique(labels_clean[mask_non_noise], return_counts=True)
            fracs = counts.astype(float) / float(n)
            big_clusters = unique[fracs > MAX_CLUSTER_FRACTION_FOR_TS]

            # Only relabel if there is at least one "big" cluster and at least one other cluster
            if big_clusters.size > 0 and unique.size > 1:
                big_mask = np.isin(labels_clean, big_clusters)
                labels_clean[big_mask] = -1
                print(
                    "[ST-DBSCAN] Re-labeled large spatiotemporal cluster(s) as noise "
                    f"for time-series use: {big_clusters.tolist()} "
                    f"(threshold={MAX_CLUSTER_FRACTION_FOR_TS:.2f})"
                )

    df_out = df[["LocationID","hour","cx","cy"]].copy()
    df_out["cluster_id"] = labels_clean
    df_out["intensity_hour"] = df["intensity_hour"].to_numpy()
    df_out["avg_fare_hour"] = df.get("avg_fare_hour", pd.Series(index=df.index, dtype=float)).to_numpy()
    df_out["avg_duration_min_hour"] = df.get("avg_duration_min_hour", pd.Series(index=df.index, dtype=float)).to_numpy()

    # --- FINAL SAFETY: ensure uniqueness per (LocationID, hour) after clustering ---
    before_dups = df_out.duplicated(subset=["LocationID", "hour"], keep=False).sum()
    if before_dups > 0:
        print(f"[ST-DBSCAN] Warning: found {before_dups} duplicated (LocationID, hour) rows after clustering; deduping.")
        df_out = df_out.drop_duplicates(subset=["LocationID", "hour"], keep="first")

    return df_out


# -------------------------
# Exports
# -------------------------
def export_zone_centroids_gj(centroids):
    g = gpd.GeoDataFrame(
        centroids[["LocationID","cx","cy"]],
        geometry=[Point(lon, lat) for lon,lat in zip(centroids["cx"], centroids["cy"])],
        crs="EPSG:4326"
    )
    g.to_file(OUT_ZONE_CENTROIDS_GJ, driver="GeoJSON")


def main():
    ensure_dirs()
    df_density, df_trips, gdf_zones = load_inputs()
    centroids = compute_zone_centroids(gdf_zones)

    zone_stats = aggregate_zone_level_stats(df_density, df_trips)
    zh_stats   = aggregate_zone_hour_stats(df_density, df_trips)

    spatial = run_spatial_dbscan(zone_stats, centroids)
    st      = run_spatiotemporal_dbscan(zh_stats, centroids)

    spatial.to_csv(OUT_SPATIAL_CSV, index=False)
    st.to_csv(OUT_SPATIOTEMPORAL_CSV, index=False)
    export_zone_centroids_gj(centroids)

    print("Wrote:", OUT_SPATIAL_CSV)
    print("Wrote:", OUT_SPATIOTEMPORAL_CSV)
    print("Wrote:", OUT_ZONE_CENTROIDS_GJ)


if __name__ == "__main__":
    main()