# compute_flows.py
# Outputs:
#   data/flows_baseline.csv
#   data/flows_enhanced.csv
#
# Requires:
#   artifacts/sample_trips.parquet
#   data/taxi_zones.geojson
#
# pip install pandas numpy geopandas shapely pyproj scikit-learn

import os
import math
import numpy as np
import pandas as pd
import geopandas as gpd
from shapely.geometry import Point
from pyproj import Transformer
from sklearn.cluster import DBSCAN

DATA_DIR = "data"
ARTIFACTS_DIR = "artifacts"
TRIPS_PARQUET = os.path.join(ARTIFACTS_DIR, "sample_trips.parquet")
ZONES_GEOJSON = os.path.join(DATA_DIR, "taxi_zones.geojson")

OUT_BASELINE = os.path.join(DATA_DIR, "flows_baseline.csv")
OUT_ENHANCED = os.path.join(DATA_DIR, "flows_enhanced.csv")

# ---- Clustering hyperparams (tune for corridor granularity) ----
EPS_METERS_CORE = 1200       # spatial proximity tolerance (orig+dest)
MIN_SAMPLES = 5              # min dense neighbors (weighted by trips)
ANGLE_SCALE = 3000           # meters per radian of bearing diff
LENGTH_SCALE = 0.002         # normalize lengths (meters * LENGTH_SCALE)

def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)

def load():
    trips = pd.read_parquet(TRIPS_PARQUET)
    zones = gpd.read_file(ZONES_GEOJSON)
    zones["LocationID"] = zones["LocationID"].astype(int)
    return trips, zones

def zone_centroids_ll_m(zones_gdf):
    """Return centroids in lon/lat and projected meters."""
    g = zones_gdf.copy()
    if g.crs is None:
        g.set_crs("EPSG:4326", inplace=True)

    g_m = g.to_crs("EPSG:3857")
    cent_m = g_m.geometry.centroid
    g_m["mx"] = cent_m.x
    g_m["my"] = cent_m.y

    g_ll = g_m.set_geometry(cent_m).to_crs("EPSG:4326")
    g_m["o_lon"] = g_ll.geometry.x
    g_m["o_lat"] = g_ll.geometry.y

    out = g_m[["LocationID", "o_lon", "o_lat", "mx", "my"]].copy()
    out["LocationID"] = out["LocationID"].astype(int)
    return out

def fare_total(df):
    cols = ["base_passenger_fare","tolls","bcf","sales_tax",
            "congestion_surcharge","airport_fee","tips"]
    present = [c for c in cols if c in df.columns]
    return df[present].sum(axis=1) if present else pd.Series(0.0, index=df.index)

def make_time_bin(df):
    col = "pickup_datetime" if "pickup_datetime" in df.columns else "request_datetime"
    dt = pd.to_datetime(df[col], errors="coerce")
    return dt.dt.hour.astype("Int64")

# ------------------------------------------------------------------
# Baseline OD aggregation
# ------------------------------------------------------------------
def build_baseline(trips, centroids):
    df = trips.copy()
    df["fare_total"] = fare_total(df)
    df["duration_min"] = df["trip_time"] / 60.0
    df["time_bin"] = make_time_bin(df)

    # Drop invalid rows
    df = df.dropna(subset=["PULocationID","DOLocationID","time_bin"])
    df["PULocationID"] = df["PULocationID"].astype(int)
    df["DOLocationID"] = df["DOLocationID"].astype(int)

    # Join origin/dest centroids
    cen_o = centroids.rename(columns={"LocationID":"PULocationID",
                                      "o_lon":"o_lon_o","o_lat":"o_lat_o",
                                      "mx":"mx_o","my":"my_o"})
    df = df.merge(cen_o, on="PULocationID", how="left")
    cen_d = centroids.rename(columns={"LocationID":"DOLocationID",
                                      "o_lon":"o_lon_d","o_lat":"o_lat_d",
                                      "mx":"mx_d","my":"my_d"})
    df = df.merge(cen_d, on="DOLocationID", how="left")

    # Aggregate by OD + hour
    g = df.groupby(["PULocationID","DOLocationID","time_bin"]).agg(
        trip_count=("PULocationID","size"),
        avg_fare=("fare_total","mean"),
        avg_duration_min=("duration_min","mean"),
        o_lon=("o_lon_o","first"),
        o_lat=("o_lat_o","first"),
        d_lon=("o_lon_d","first"),
        d_lat=("o_lat_d","first"),
    ).reset_index()

    # Clean up + enforce numeric
    g = g.dropna(subset=["o_lon","o_lat","d_lon","d_lat"])
    g["time_bin"] = g["time_bin"].astype(int)
    g["trip_count"] = g["trip_count"].astype(int)

    g.rename(columns={"PULocationID":"origin_zone",
                      "DOLocationID":"destination_zone"}, inplace=True)
    g["flow_cluster_id"] = pd.NA
    g["algo_version"] = "baseline"
    return g

# ------------------------------------------------------------------
# Flow-clustered enhanced version
# ------------------------------------------------------------------
def build_enhanced(baseline, centroids):
    # Join projected coords for origin/dest
    c_o = centroids.rename(columns={"LocationID":"origin_zone","mx":"mx_o","my":"my_o"})
    c_d = centroids.rename(columns={"LocationID":"destination_zone","mx":"mx_d","my":"my_d"})
    df = baseline.merge(c_o[["origin_zone","mx_o","my_o"]], on="origin_zone", how="left")
    df = df.merge(c_d[["destination_zone","mx_d","my_d"]], on="destination_zone", how="left")

    # Drop NaNs in coords
    df = df.dropna(subset=["mx_o","my_o","mx_d","my_d","trip_count"]).copy()

    # Compute bearing/length
    dx = df["mx_d"].to_numpy() - df["mx_o"].to_numpy()
    dy = df["my_d"].to_numpy() - df["my_o"].to_numpy()
    length = np.hypot(dx, dy)
    bearing = np.arctan2(dy, dx)
    bearing = np.where(np.isfinite(bearing), bearing, 0.0)

    df["bearing"] = bearing
    df["length_m"] = length

    # Build feature matrix
    X = np.column_stack([
        df["mx_o"].to_numpy(),
        df["my_o"].to_numpy(),
        df["mx_d"].to_numpy(),
        df["my_d"].to_numpy(),
        df["bearing"].to_numpy() * ANGLE_SCALE,
        df["length_m"].to_numpy() * LENGTH_SCALE
    ]).astype("float64")

    # Filter invalids
    good = np.isfinite(X).all(axis=1)
    df = df.loc[good].copy()
    X = X[good]
    weights = df["trip_count"].to_numpy().astype(float)

    # DBSCAN clustering
    model = DBSCAN(eps=EPS_METERS_CORE, min_samples=MIN_SAMPLES, metric="euclidean")
    labels = model.fit_predict(X, sample_weight=weights)

    out = df.copy()
    out["flow_cluster_id"] = labels
    out["algo_version"] = "enhanced"

    out = out.dropna(subset=["o_lon","o_lat","d_lon","d_lat","time_bin"])
    out["time_bin"] = out["time_bin"].astype(int)
    out["trip_count"] = out["trip_count"].astype(int)

    keep = [
        "origin_zone","destination_zone","time_bin","trip_count",
        "flow_cluster_id","algo_version",
        "o_lon","o_lat","d_lon","d_lat","avg_fare","avg_duration_min"
    ]
    return out[keep]

# ------------------------------------------------------------------
def main():
    ensure_dirs()
    trips, zones = load()
    centroids = zone_centroids_ll_m(zones)

    baseline = build_baseline(trips, centroids)
    enhanced = build_enhanced(baseline, centroids)

    baseline.to_csv(OUT_BASELINE, index=False)
    enhanced.to_csv(OUT_ENHANCED, index=False)
    print("✅ Wrote", OUT_BASELINE)
    print("✅ Wrote", OUT_ENHANCED)

if __name__ == "__main__":
    main()