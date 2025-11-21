# build_zone_hour_clusters.py
from pathlib import Path
import pandas as pd

DATA = Path("data")

DENSITY_PATH = DATA / "zone_hour_density.parquet"   # must have: PULocationID, hour
ST_CSV       = DATA / "clusters_spatiotemporal.csv"
OUT_PARQUET  = DATA / "zone_hour_clusters.parquet"

def main():
    # 1) Universe of all (zone, hour) combinations you care about
    density = pd.read_parquet(DENSITY_PATH)
    zh = density[["PULocationID", "hour"]].drop_duplicates()

    # 2) Spatiotemporal cluster labels
    st = pd.read_csv(ST_CSV)
    st = st.rename(columns={
        "LocationID": "PULocationID",
        "cluster_id": "cluster_st"
    })[["PULocationID", "hour", "cluster_st"]]

    # 3) Merge → only one cluster label (cluster_st)
    df = zh.merge(st, on=["PULocationID", "hour"], how="left")

    # 4) Save
    OUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT_PARQUET, index=False)
    print("Wrote", OUT_PARQUET)

if __name__ == "__main__":
    main()