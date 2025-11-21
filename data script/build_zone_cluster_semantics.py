#!/usr/bin/env python
"""
Build semantic labels for *zone* clusters from clusters_spatiotemporal.csv.

Usage (basic):
python build_zone_cluster_semantics.py \
  --clusters data/clusters_spatiotemporal_refined.csv \
  --lookup   data/taxi_zone_lookup.csv \
  --out      data/cluster_semantics_t.json \
  --ignore_noise

This is analogous to the flows-based semantics script, but for
zone/hour clusters (cluster_id on LocationID + hour).
"""

import argparse
import json
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import pandas as pd

# -------------------------------------------------------------------
# 1. Canonical NYC area aliases
# -------------------------------------------------------------------
# Map a canonical area label -> list of substrings that identify that area.
# You can keep expanding this as needed.
CANONICAL_AREAS: dict[str, list[str]] = {
    # --- Airports ---
    "JFK (Queens)": [
        "JFK Airport",
    ],
    "LaGuardia (Queens)": [
        "LaGuardia Airport",
        "East Elmhurst",   # often clustered with LGA
    ],
    "Newark Airport (NJ)": [
        "Newark Airport",
    ],

    # --- Midtown / Core Manhattan ---
    "Midtown (Manhattan)": [
        "Times Sq/Theatre District",
        "Midtown Center",
        "Midtown North",
        "Midtown East",
        "Midtown South",
        "Penn Station/Madison Sq West",
        "Clinton East",
        "Clinton West",
        "West Chelsea/Hudson Yards",
        "East Chelsea",
    ],

    "Downtown (Manhattan)": [
        "World Trade Center",
        "Financial District North",
        "Financial District South",
        "Battery Park City",
        "TriBeCa/Civic Center",
    ],

    "West Village (Manhattan)": [
        "West Village",
        "Meatpacking/West Village West",
        "Greenwich Village South",
        "Union Sq",
    ],

    "East Village / LES (Manhattan)": [
        "East Village",
        "Lower East Side",
        "Little Italy/NoLiTa",
        "SoHo",
    ],

    "Upper East Side (Manhattan)": [
        "Upper East Side North",
        "Upper East Side South",
        "Yorkville West",
        "Yorkville East",
        "Lenox Hill West",
        "Lenox Hill East",
        "Sutton Place/Turtle Bay North",
    ],

    "Upper West Side (Manhattan)": [
        "Upper West Side North",
        "Upper West Side South",
        "Lincoln Square East",
        "Lincoln Square West",
        "Manhattan Valley",
        "Morningside Heights",
    ],

    # --- Queens hot areas ---
    "Corona & Jackson Heights (Queens)": [
        "Corona",
        "Jackson Heights",
        "Elmhurst",
    ],

    "Jamaica / Hillside (Queens)": [
        "Jamaica", "Jamaica Bay",
        "Hillcrest/Pomonok",
        "Briarwood/Jamaica Hills",
    ],

    # --- Brooklyn cores ---
    "Crown Heights (Brooklyn)": [
        "Crown Heights North",
        "Crown Heights South",
    ],

    "Park Slope (Brooklyn)": [
        "Park Slope",
        "Prospect Heights",
        "Gowanus",
    ],

    "Bushwick (Brooklyn)": [
        "Bushwick South",
        "Bushwick North",
    ],

    "Williamsburg & Greenpoint (Brooklyn)": [
        "Williamsburg North Side",
        "Williamsburg South Side",
        "Greenpoint",
    ],

    # You can keep adding more:
    # "Astoria (Queens)": [...],
    # "Flushing (Queens)": [...],
    # "Harlem (Manhattan)": [...],
}


def pick_alias_from_zones(top_zone_names: list[str]) -> str | None:
    """
    Given a list of zone names sorted by importance (most-used first),
    return a canonical alias like "Midtown (Manhattan)" or
    "Corona & Jackson Heights (Queens)" if we can infer one.
    """
    if not top_zone_names:
        return None

    # Normalize once
    norm_zones = [z.lower() for z in top_zone_names]

    # 1) Try to find the *first* canonical area whose patterns appear
    for canonical_label, patterns in CANONICAL_AREAS.items():
        for pat in patterns:
            pat_l = pat.lower()
            # if any zone name contains this pattern
            if any(pat_l in z for z in norm_zones):
                return canonical_label

    # 2) If nothing matched, give up (fallback logic will handle it)
    return None


# -------------------------------------------------------------------
# 2. I/O for zone clusters
# -------------------------------------------------------------------
def load_clusters(path: Path) -> pd.DataFrame:
    """
    Expect columns at least:
        LocationID, hour, cluster_id, intensity_hour

    (this matches compute_clusters.py's spatiotemporal output.)
    """
    df = pd.read_csv(path)
    required = {"LocationID", "hour", "cluster_id"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{path} is missing required columns: {missing}")
    # intensity_hour is strongly recommended, but we can fallback to 1s
    if "intensity_hour" not in df.columns:
        df["intensity_hour"] = 1.0
    df["LocationID"] = df["LocationID"].astype(int)
    df["hour"] = df["hour"].astype(int)
    df["cluster_id"] = df["cluster_id"].astype(int)
    return df


def load_lookup(path: Path | None) -> pd.DataFrame | None:
    if path is None:
        return None
    df = pd.read_csv(path)
    if "LocationID" not in df.columns:
        raise ValueError(
            f"{path} must contain a 'LocationID' column (Zone/Borough optional)."
        )
    return df


def make_zone_lookup(
    lookup_df: pd.DataFrame | None,
) -> Tuple[Callable[[int], str], Callable[[int], str]]:
    """
    Return (zone_name, borough_name) for LocationID.
    """
    if lookup_df is None:

        def fallback_zone_name(zid: int) -> str:
            return f"Zone {zid}"

        def fallback_borough(zid: int) -> str:
            return "Unknown"

        return fallback_zone_name, fallback_borough

    df = lookup_df.copy()
    df["LocationID"] = df["LocationID"].astype(int)
    df = df.set_index("LocationID")

    def norm_borough(val: str | float) -> str:
        if pd.isna(val):
            return "Unknown"
        s = str(val).strip().lower()
        if "manhattan" in s:
            return "Manhattan"
        if "brooklyn" in s:
            return "Brooklyn"
        if "queens" in s:
            return "Queens"
        if "bronx" in s:
            return "The Bronx"
        if "staten" in s:
            return "Staten Island"
        return val if val else "Unknown"

    def zone_name(zid: int) -> str:
        try:
            row = df.loc[zid]
        except KeyError:
            return f"Zone {zid}"
        if "Zone" in row:
            return str(row["Zone"])
        return f"Zone {zid}"

    def borough_name(zid: int) -> str:
        try:
            row = df.loc[zid]
        except KeyError:
            return "Unknown"
        if "Borough" in row:
            return norm_borough(row["Borough"])
        return "Unknown"

    return zone_name, borough_name


# -------------------------------------------------------------------
# 3. Area labels (+ aliasing)
# -------------------------------------------------------------------
def area_label_from_zones(
    weighted_counts: pd.Series,
    zone_name: Callable[[int], str],
    borough_name: Callable[[int], str],
    max_zones: int = 3,
) -> tuple[str, list[str], str]:
    """
    Given a Series indexed by LocationID with intensity weights,
    build a human-readable area label + top zone names + borough-area label.
    """
    if weighted_counts.empty:
        return "Unknown area", [], "Unknown area"

    sorted_counts = weighted_counts.sort_values(ascending=False)

    top_zone_ids = sorted_counts.index.to_list()[:max_zones]
    top_zone_names = [zone_name(int(zid)) for zid in top_zone_ids]

    # Borough dominance
    borough_counts: Dict[str, float] = {}
    for zid, val in sorted_counts.items():
        b = borough_name(int(zid))
        borough_counts[b] = borough_counts.get(b, 0.0) + float(val)

    borough_area_label = "Unknown area"
    if borough_counts:
        dom_borough, dom_val = max(borough_counts.items(), key=lambda kv: kv[1])
        total_val = float(sorted_counts.sum())
        share = dom_val / total_val if total_val > 0 else 0.0
        if dom_borough != "Unknown" and share >= 0.7:
            borough_area_label = f"{dom_borough} area"

    alias_label = pick_alias_from_zones(top_zone_names)
    if alias_label:
        area_label = alias_label
    else:
        if borough_area_label != "Unknown area":
            area_label = borough_area_label
        else:
            if top_zone_names:
                if len(top_zone_names) == 1:
                    area_label = top_zone_names[0]
                else:
                    area_label = ", ".join(top_zone_names[:2])
            else:
                area_label = "Mixed area"

    return area_label, top_zone_names, borough_area_label


# -------------------------------------------------------------------
# 4. Time-of-day descriptor from peak_hours
# -------------------------------------------------------------------
def classify_time_window(peak_hours: list[int]) -> str:
    """
    Turn a list of peak hours (0–23) into a short descriptor like
    'AM peak', 'PM peak', 'Late night', etc.
    """
    if not peak_hours:
        return "mixed hours"

    hours = [int(h) for h in peak_hours]

    buckets: Dict[str, set[int]] = {
        "Late night": {23, 0, 1, 2, 3, 4, 5},
        "AM peak":    {6, 7, 8, 9},
        "Midday":     {10, 11, 12, 13, 14},
        "PM peak":    {15, 16, 17, 18, 19},
        "Evening":    {20, 21, 22},
    }

    counts: Dict[str, int] = {k: 0 for k in buckets}
    for h in hours:
        for name, hs in buckets.items():
            if h in hs:
                counts[name] += 1

    # pick the bucket with max hits
    best_name = max(counts.items(), key=lambda kv: kv[1])[0]
    total_hits = sum(counts.values())
    if total_hits == 0:
        return "mixed hours"

    share = counts[best_name] / total_hits
    if share < 0.5:
        return "mixed hours"

    return best_name


# -------------------------------------------------------------------
# 5. Per-cluster semantics (for zone clusters)
# -------------------------------------------------------------------
def build_semantics_for_zone_cluster(
    cluster_id: int,
    clusters_df: pd.DataFrame,
    zone_name: Callable[[int], str],
    borough_name: Callable[[int], str],
) -> dict:
    """
    Build a semantic description for one zone cluster_id.

    Returns something like:
        {
            "label": "Queens – Far Rockaway (PM peak)",
            "top_zones": [...],
            "borough_area": "Queens area",
            "time_window": "PM peak",
            "total_intensity": 123456,
            "n_zone_hours": 240,
            "n_zones": 20,
            "peak_hours": [8, 9, 17, 18]
        }
    """
    rows = clusters_df[clusters_df["cluster_id"] == cluster_id]
    if rows.empty:
        return {}

    total_intensity = float(rows["intensity_hour"].sum())
    n_zone_hours = int(len(rows))
    n_zones = int(rows["LocationID"].nunique())

    # Weighted zone distribution
    zone_weights = rows.groupby("LocationID")["intensity_hour"].sum()

    area_label, top_zone_names, borough_area = area_label_from_zones(
        zone_weights, zone_name, borough_name
    )

    # Hour-of-day profile: where does this cluster "live" in time?
    hour_weights = rows.groupby("hour")["intensity_hour"].sum().sort_values(ascending=False)
    peak_hours = [int(h) for h in hour_weights.head(4).index.to_list()]

    time_window = classify_time_window(peak_hours)

    # --------- Build a more specific label ----------
    # Start from the canonical / borough / zone label and avoid duplicates.
    base_label: str

    # Normalize for comparison
    area_norm = area_label.lower()
    top0 = top_zone_names[0] if top_zone_names else None
    top0_norm = top0.lower() if top0 else None

    if area_label.endswith(" area") and top0:
        # E.g. "Queens area" + "Far Rockaway" → "Queens – Far Rockaway"
        borough_core = area_label.replace(" area", "")
        base_label = f"{borough_core} – {top0}"
    elif top0:
        # If the area label already basically equals the top zone
        # (e.g. "Corona & Jackson Heights (Queens)" vs "Corona"),
        # avoid "A, B – A" type redundancy.
        if area_norm == top0_norm or area_norm in top0_norm or top0_norm in area_norm:
            base_label = area_label
        else:
            base_label = f"{area_label} – {top0}"
    else:
        base_label = area_label

    if time_window != "mixed hours":
        label = f"{base_label} ({time_window})"
    else:
        label = base_label

    return {
        "label": label,
        "area_key": base_label,
        "top_zones": top_zone_names,
        "borough_area": borough_area,
        "time_window": time_window,
        "total_intensity": total_intensity,
        "n_zone_hours": n_zone_hours,
        "n_zones": n_zones,
        "peak_hours": peak_hours,
    }


# -------------------------------------------------------------------
# 6. CLI
# -------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Build semantic labels for zone/hour clusters from clusters_spatiotemporal.csv"
    )
    parser.add_argument(
        "--clusters",
        type=Path,
        required=True,
        help="Path to clusters_spatiotemporal.csv (LocationID, hour, cluster_id, intensity_hour)",
    )
    parser.add_argument(
        "--lookup",
        type=Path,
        default=Path("data/taxi_zone_lookup.csv"),
        help="Optional taxi_zone_lookup.csv with LocationID, Zone, Borough",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/cluster_semantics_t.json"),
        help="Output JSON path (default: data/cluster_semantics_t.json)",
    )
    parser.add_argument(
        "--min_total_intensity",
        type=float,
        default=0.0,
        help="Minimum total intensity per cluster to include (default: 0 = keep all).",
    )
    parser.add_argument(
        "--ignore_noise",
        action="store_true",
        help="If set, drop cluster_id == -1 (DBSCAN noise).",
    )

    args = parser.parse_args()

    print(f"Loading clusters from {args.clusters} ...")
    clusters = load_clusters(args.clusters)

    if args.ignore_noise:
        clusters = clusters[clusters["cluster_id"] != -1].copy()

    # Aggregate to know which clusters exist + their size
    summary = clusters.groupby("cluster_id").agg(
        total_intensity=("intensity_hour", "sum"),
        n_zone_hours=("intensity_hour", "size"),
        n_zones=("LocationID", "nunique"),
    ).reset_index()

    print(f"Found {len(summary)} clusters (incl. noise if present).")

    strong = summary[summary["total_intensity"] >= args.min_total_intensity]
    print(f"Keeping {len(strong)} clusters with total_intensity >= {args.min_total_intensity}.")

    lookup_df = load_lookup(args.lookup)
    zone_name, borough_name = make_zone_lookup(lookup_df)

    semantics: Dict[str, dict] = {}

    print("Building semantics for each selected cluster ...")
    for _, row in strong.iterrows():
        cid = int(row["cluster_id"])
        info = build_semantics_for_zone_cluster(cid, clusters, zone_name, borough_name)
        if not info:
            continue
        semantics[str(cid)] = info

    print(f"Writing semantics for {len(semantics)} clusters to {args.out} ...")
    args.out.write_text(json.dumps(semantics, indent=2), encoding="utf-8")
    print("Done.")


if __name__ == "__main__":
    main()