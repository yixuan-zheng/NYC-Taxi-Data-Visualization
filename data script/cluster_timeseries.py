# === NYC FHVHV Cluster Time-Series Stability (Spatiotemporal) ===
# Inputs (all in data/):
#   data/zone_hour_clusters.parquet        # PULocationID, hour, cluster_st
#   data/cleaned_fhvhv_trips.parquet       # full cleaned trips 
#
# Auto-generated cache (also in data/):
#   data/daily_zone_hour.parquet           # (date, hour, PULocationID) → trip_count [+ total_fare]
#
# Outputs (all in data/):
#   data/cluster_timeseries.csv        # hourly demand per (refined) cluster
#   data/cluster_ts_metrics.csv        # DTW/ACF/SNR per cluster
#

INCLUDE_FARES = True

from pathlib import Path
import numpy as np
import pandas as pd
import duckdb

# ------------------------ Paths ------------------------
DATA = Path("data")
DATA.mkdir(exist_ok=True)

# IMPORTANT: use the refined cluster labels
CLUSTERS_PATH   = DATA / "zone_hour_clusters.parquet"
TRIPS_PATH      = DATA / "cleaned_fhvhv_trips.parquet"
DAILY_CACHE     = DATA / "daily_zone_hour.parquet"

TS_OUT_CSV = DATA / "cluster_timeseries.csv"
METRICS_OUT_CSV = DATA / "cluster_ts_metrics.csv"

assert CLUSTERS_PATH.exists(), f"Missing required file: {CLUSTERS_PATH}"
assert TRIPS_PATH.exists(),    f"Missing required file: {TRIPS_PATH}"

# ------------------------ 0) Build (or reuse) the daily cache ------------------------
con = duckdb.connect()

if not DAILY_CACHE.exists():
    print("• Building daily cache (date × hour × PULocationID)…")
    if INCLUDE_FARES:
        fare_sum = (
            "COALESCE(base_passenger_fare,0) + COALESCE(tolls,0) + COALESCE(bcf,0) + "
            "COALESCE(sales_tax,0) + COALESCE(congestion_surcharge,0) + "
            "COALESCE(airport_fee,0) + COALESCE(tips,0) + COALESCE(driver_pay,0)"
        )
        sum_fares_sql = f", SUM({fare_sum})::DOUBLE AS total_fare"
    else:
        sum_fares_sql = ""

    con.execute(f"""
        COPY (
          SELECT
            CAST(pickup_datetime AS DATE)              AS date,
            EXTRACT(hour FROM pickup_datetime)::INT    AS hour,
            PULocationID,
            COUNT(*)                                    AS trip_count
            {sum_fares_sql}
          FROM read_parquet('{TRIPS_PATH.as_posix()}')
          GROUP BY 1,2,3
        )
        TO '{DAILY_CACHE.as_posix()}'
        (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    print(f"  → Saved cache: {DAILY_CACHE}")
else:
    print(f"• Reusing cache: {DAILY_CACHE}")

# ------------------------ 1) Load cache + cluster labels ------------------------
print(f"\nLoading daily cache from: {DAILY_CACHE}")
daily = pd.read_parquet(DAILY_CACHE)

print(f"Loading refined zone-hour clusters from: {CLUSTERS_PATH}")
lab_raw = pd.read_parquet(CLUSTERS_PATH)

# Normalize column names to match expectations
lab = (
    lab_raw.rename(columns={
        "LocationID": "PULocationID",
        "cluster_id": "cluster_st"
    })[["PULocationID", "hour", "cluster_st"]]
    .drop_duplicates()
)

print("\nRefined cluster_st distribution (first 20):")
print(lab["cluster_st"].value_counts().head(20))

# Merge cluster_st onto daily aggregate
df = daily.merge(
    lab,
    on=["PULocationID", "hour"],
    how="inner",
    validate="m:1"
)

# Timestamp column for time-series metrics
df["timestamp"] = pd.to_datetime(
    df["date"].astype(str) + " " + df["hour"].astype(str) + ":00:00"
)

# ------------------------ 2) Build per-cluster time series ------------------------
def to_cluster_ts(df_in: pd.DataFrame) -> pd.DataFrame:
    ts = (
        df_in
        .groupby(["cluster_st", "timestamp", "hour"], as_index=False)
        .agg(
            trip_count=("trip_count", "sum"),
            total_fare=(
                ("total_fare", "sum") if "total_fare" in df_in.columns
                else ("trip_count", "sum")
            )
        )
    )
    ts = ts.rename(columns={"cluster_st": "cluster"})
    ts = ts.sort_values(["cluster", "timestamp"])
    return ts

ts_all = to_cluster_ts(df)

print(f"\ncluster_timeseries shape: {ts_all.shape}")
print("Cluster distribution in timeseries (first 20):")
print(ts_all["cluster"].value_counts().head(20))

# ------------------------ 3) Metrics helpers (DTW, ACF, SNR) ------------------------
def _dtw_distance(a: np.ndarray, b: np.ndarray) -> float:
    """DTW (L1) with dynamic programming, cheap for length-24 vectors."""
    n, m = len(a), len(b)
    D = np.full((n + 1, m + 1), np.inf, dtype=float)
    D[0, 0] = 0.0
    for i in range(1, n + 1):
        ai = a[i - 1]
        for j in range(1, m + 1):
            D[i, j] = abs(ai - b[j - 1]) + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])
    return D[n, m] / (n + m)

def _autocorr(x: np.ndarray, lag: int) -> float:
    if len(x) <= lag:
        return np.nan
    s = pd.Series(x, dtype="float") - np.mean(x)
    num = (s.iloc[:-lag] * s.iloc[lag:]).sum()
    den = (s * s).sum()
    return float(num / den) if den != 0 else np.nan

def _snr_hourly(values: pd.Series, hours: pd.Series) -> float:
    vals = values.astype(float)
    prof = vals.groupby(hours).transform("mean")
    residual = vals - prof
    v_sig = float(np.var(prof, ddof=1)) if len(prof) > 1 else 0.0
    v_res = float(np.var(residual, ddof=1)) if len(residual) > 1 else np.nan
    if np.isnan(v_res) or v_res == 0:
        return np.inf if v_sig > 0 else np.nan
    return v_sig / v_res

def _dtw_day_to_mean(day_hour_df: pd.DataFrame, value_col: str) -> float:
    pivot = (
        day_hour_df
        .pivot_table(index="day", columns="hour", values=value_col, aggfunc="sum")
        .reindex(columns=list(range(24)), fill_value=0)
        .sort_index()
    )

    M = pivot.to_numpy(dtype=float)
    if M.shape[0] < 2:
        return np.nan

    row_sums = M.sum(axis=1, keepdims=True)
    row_sums[row_sums == 0] = 1.0
    M_norm = M / row_sums

    mean_prof = M_norm.mean(axis=0)
    return float(np.mean([_dtw_distance(row, mean_prof) for row in M_norm]))

# ------------------------ 4) Compute metrics per cluster ------------------------
def cluster_metrics(ts: pd.DataFrame, value_col: str) -> pd.DataFrame:
    rows = []
    for cluster, g in ts.groupby("cluster"):
        g = g.sort_values("timestamp").copy()
        g["day"] = g["timestamp"].dt.date
        day_hour = g[["day", "hour", value_col]].dropna()

        dtw_mean = _dtw_day_to_mean(day_hour, value_col)
        x = g[value_col].to_numpy(dtype=float)

        rows.append(dict(
            cluster=int(cluster),
            metric_target=value_col,
            n_points=len(x),
            dtw_daily_mean=dtw_mean,
            autocorr_lag1=_autocorr(x, 1),
            autocorr_lag24=_autocorr(x, 24),
            snr_hourly=_snr_hourly(g[value_col], g["hour"])
        ))
    return pd.DataFrame(rows)

m_counts = cluster_metrics(ts_all, "trip_count")
metrics = m_counts

if "total_fare" in ts_all.columns and INCLUDE_FARES:
    m_fares = cluster_metrics(ts_all, "total_fare")
    metrics = pd.concat([m_counts, m_fares], ignore_index=True)

summary = (
    metrics
    .groupby(["metric_target"], as_index=False)
    .agg(
        clusters=("cluster", "nunique"),
        dtw_daily_mean=("dtw_daily_mean", "mean"),
        autocorr_lag1=("autocorr_lag1", "mean"),
        autocorr_lag24=("autocorr_lag24", "mean"),
        snr_hourly=("snr_hourly", "mean")
    )
)

# ------------------------ 5) Save outputs ------------------------
TS_OUT_CSV = DATA / "cluster_timeseries.csv"
ts_all.to_csv(TS_OUT_CSV, index=False)
print(f"Saved timeseries CSV → {TS_OUT_CSV}")
metrics.to_csv(METRICS_OUT_CSV, index=False)

print("\n--- Spatiotemporal Cluster Time-Series Stability (lower DTW, higher ACF/SNR are better) ---")
print(summary.to_string(index=False))
print(f"\nSaved timeseries CSV → {TS_OUT_CSV}")
print(f"Saved metrics CSV   → {METRICS_OUT_CSV}")