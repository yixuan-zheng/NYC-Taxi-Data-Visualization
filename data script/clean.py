import os, random
import duckdb
import pandas as pd

RAW_PARQUET = "data/fhvhv_tripdata_year-month.parquet"
ZONES_CSV   = "data/taxi_zone_lookup.csv"
OUT_DIR     = "artifacts"
OUT_DENSITY = os.path.join(OUT_DIR, "zone_hour_density.parquet")
OUT_SAMPLE  = os.path.join(OUT_DIR, "trips.parquet")
SAMPLE_FRAC = 0.15
RANDOM_SEED = 42

os.makedirs(OUT_DIR, exist_ok=True)
random.seed(RANDOM_SEED)

raw_path   = os.path.abspath(RAW_PARQUET)
zones_path = os.path.abspath(ZONES_CSV)
con = duckdb.connect()

# ------------------------------------------------------------
# Load raw trips and zone lookup
con.execute(f"""
    CREATE OR REPLACE TEMP VIEW trips AS
    SELECT * FROM read_parquet('{raw_path}')
""")
con.execute(f"""
    CREATE OR REPLACE TEMP VIEW zones AS
    SELECT CAST(LocationID AS INTEGER) AS LocationID, Borough, Zone
    FROM read_csv_auto('{zones_path}')
""")

# Cleaning
con.execute("""
    CREATE OR REPLACE TEMP VIEW cleaned AS
    SELECT
        request_datetime, pickup_datetime, dropoff_datetime,
        PULocationID, DOLocationID, hvfhs_license_num,
        trip_miles, trip_time,
        (trip_miles / NULLIF(trip_time,0) * 3600.0) AS speed_mph,
        GREATEST(COALESCE(base_passenger_fare,0),0) AS base_passenger_fare,
        GREATEST(COALESCE(tolls,0),0) AS tolls,
        GREATEST(COALESCE(bcf,0),0) AS bcf,
        GREATEST(COALESCE(sales_tax,0),0) AS sales_tax,
        GREATEST(COALESCE(congestion_surcharge,0),0) AS congestion_surcharge,
        GREATEST(COALESCE(airport_fee,0),0) AS airport_fee,
        GREATEST(COALESCE(tips,0),0) AS tips,
        GREATEST(COALESCE(driver_pay,0),0) AS driver_pay
    FROM trips
    WHERE
        trip_miles BETWEEN 0.1 AND 100
        AND trip_time BETWEEN 30 AND 7200
        AND (trip_miles / NULLIF(trip_time,0) * 3600.0) BETWEEN 1 AND 70
""")

# Join zones + compute pickup hour
con.execute("""
    CREATE OR REPLACE TEMP VIEW cleaned_with_zone AS
    SELECT
        c.*,
        z.Borough AS PU_Borough,
        z.Zone AS PU_Zone,
        EXTRACT(hour FROM c.pickup_datetime)::INT AS pickup_hour
    FROM cleaned c
    LEFT JOIN zones z ON c.PULocationID = z.LocationID
""")

# Export zone-hour density (for clustering)
con.execute(f"""
    COPY (
        SELECT PULocationID,
               pickup_hour AS hour,
               COUNT(*) AS trip_count
        FROM cleaned_with_zone
        GROUP BY 1,2
        ORDER BY trip_count DESC
    ) TO '{OUT_DENSITY}' (FORMAT PARQUET)
""")

# 15 % random sample 
df = con.execute("SELECT * FROM cleaned_with_zone").fetch_df()
mask = [random.random() < SAMPLE_FRAC for _ in range(len(df))]
sample = df.loc[mask]

# Save sample + density
sample_cols = [
    "request_datetime","pickup_datetime","dropoff_datetime",
    "PULocationID","DOLocationID","PU_Borough","PU_Zone",
    "hvfhs_license_num","trip_miles","trip_time","speed_mph",
    "base_passenger_fare","tolls","bcf","sales_tax",
    "congestion_surcharge","airport_fee","tips","driver_pay"
]
sample[sample_cols].to_parquet(OUT_SAMPLE, index=False)

# Summary
n_raw   = con.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
n_clean = len(df)
n_samp  = len(sample)

print(f"Raw rows:     {n_raw:,}")
print(f"Cleaned rows: {n_clean:,}")
print(f"Sample rows:  {n_samp:,}  (~{n_samp/max(n_clean,1):.1%})")
print(f"Saved: {OUT_DENSITY}")
print(f"Saved: {OUT_SAMPLE}")
