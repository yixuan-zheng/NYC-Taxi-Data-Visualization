#!/usr/bin/env python
"""
Build semantic labels for flow clusters from flows.csv.

Usage (basic):
    python build_flow_cluster_semantics.py \
        --flows data/flows.csv \
        --lookup data/taxi_zone_lookup.csv \
        --out cluster_semantics.json

If you don't have a lookup file with zone names/boroughs, omit --lookup;
the script will fall back to "Zone <id>" and no borough info.
"""

import argparse
import json
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import pandas as pd


# -------------------------------------------------------------------
# 1. Zone → area alias rules
# -------------------------------------------------------------------
# These are *textual* pattern matches on the official TLC zone names.
# We scan the top zones for a cluster and pick the first matching alias;
# that gives us short, corridor-friendly labels like "Midtown ↔ JFK".
#
# Order matters: earlier patterns have higher priority.
ALIAS_RULES: List[Tuple[str, str]] = [
    # Airports / Port Authority
    ("JFK Airport", "JFK"),
    ("LaGuardia Airport", "LaGuardia"),
    ("Newark Airport", "EWR"),

    # Midtown core
    ("Times Sq/Theatre District", "Midtown"),
    ("Midtown Center", "Midtown"),
    ("Midtown North", "Midtown"),
    ("Midtown East", "Midtown"),
    ("Midtown South", "Midtown"),
    ("Penn Station/Madison Sq West", "Midtown"),

    # Midtown west / Hudson Yards
    ("West Chelsea/Hudson Yards", "Hudson Yards"),
    ("East Chelsea", "Chelsea"),
    ("Clinton East", "Midtown West"),
    ("Clinton West", "Midtown West"),

    # Upper East Side
    ("Upper East Side North", "Upper East Side"),
    ("Upper East Side South", "Upper East Side"),
    ("Yorkville West", "Upper East Side"),
    ("Yorkville East", "Upper East Side"),
    ("Lenox Hill West", "Upper East Side"),
    ("Lenox Hill East", "Upper East Side"),
    ("Sutton Place/Turtle Bay North", "Upper East Side"),

    # Upper West Side
    ("Upper West Side North", "Upper West Side"),
    ("Upper West Side South", "Upper West Side"),
    ("Lincoln Square East", "Upper West Side"),
    ("Lincoln Square West", "Upper West Side"),
    ("Manhattan Valley", "Upper West Side"),
    ("Morningside Heights", "Upper West Side"),

    # Downtown / Financial
    ("Financial District North", "Downtown"),
    ("World Trade Center", "Downtown"),
    ("Battery Park City", "Battery Park City"),
    ("TriBeCa/Civic Center", "Tribeca"),

    # Village / SoHo / LES
    ("West Village", "West Village"),
    ("Meatpacking/West Village West", "Meatpacking"),
    ("Greenwich Village South", "Greenwich Village"),
    ("East Village", "East Village"),
    ("Lower East Side", "Lower East Side"),
    ("Little Italy/NoLiTa", "NoLiTa"),
    ("SoHo", "SoHo"),
    ("Union Sq", "Union Square"),

    # Generic fallback buckets (only if nothing above matched)
    ("Harlem", "Harlem"),
    ("Chelsea", "Chelsea"),
]


def pick_alias_from_zones(top_zone_names: List[str]) -> str | None:
    """
    Given a list of zone names sorted by importance (most-used first),
    return a short alias like "JFK" or "Midtown" if we can infer one.

    We scan ALIAS_RULES in order and return the first match.
    """
    if not top_zone_names:
        return None

    for pattern, alias in ALIAS_RULES:
        pat_lower = pattern.lower()
        for z in top_zone_names:
            if pat_lower in z.lower():
                return alias

    return None


# -------------------------------------------------------------------
# 2. I/O helpers
# -------------------------------------------------------------------
def load_flows(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    required_cols = {
        "origin_zone",
        "destination_zone",
        "time_bin",
        "trip_count",
        "flow_cluster_id",
    }
    missing = required_cols - set(df.columns)
    if missing:
        raise ValueError(f"{path} is missing required columns: {missing}")
    return df


def load_lookup(path: Path | None) -> pd.DataFrame | None:
    if path is None:
        return None
    df = pd.read_csv(path)
    # Very common schema: LocationID, Zone, Borough
    # We'll be flexible but expect at least LocationID
    if "LocationID" not in df.columns:
        raise ValueError(
            f"{path} must contain a 'LocationID' column (Zone/Borough optional)."
        )
    return df


def make_zone_lookup(
    lookup_df: pd.DataFrame | None,
) -> Tuple[Callable[[int], str], Callable[[int], str]]:
    """
    Return (zone_name, borough_name):

        zone_name(zid)   -> human-readable zone name
        borough_name(zid)-> normalized borough, e.g. "Manhattan"

    If no lookup_df is provided, we still return basic functions.
    """
    if lookup_df is None:

        def fallback_zone_name(zid: int) -> str:
            return f"Zone {zid}"

        def fallback_borough(zid: int) -> str:
            return "Unknown"

        return fallback_zone_name, fallback_borough

    # Normalize a bit
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
# 3. Cluster summarization
# -------------------------------------------------------------------
def summarize_clusters(flows: pd.DataFrame) -> pd.DataFrame:
    """
    Compute per-cluster aggregates:
        - total_trip
        - n_rows (rows in flows)
        - n_pairs (distinct origin/dest pairs)
    Excludes flow_cluster_id == -1 (noise).
    """
    df = flows[flows["flow_cluster_id"] != -1].copy()
    df["flow_cluster_id"] = df["flow_cluster_id"].astype(int)

    # Total trips and row counts
    agg_basic = df.groupby("flow_cluster_id").agg(
        total_trip=("trip_count", "sum"),
        n_rows=("trip_count", "size"),
    )

    # Distinct OD pairs per cluster
    pairs = (
        df.groupby(["flow_cluster_id", "origin_zone", "destination_zone"])
        .size()
        .reset_index(name="rows")
    )
    agg_pairs = (
        pairs.groupby("flow_cluster_id")
        .agg(n_pairs=("rows", "size"))
    )

    summary = agg_basic.join(agg_pairs)
    return summary


def pick_strong_clusters(
    summary: pd.DataFrame,
    min_total_trips: int = 5000,
    min_pairs: int = 5,
) -> pd.Index:
    """
    Heuristic: keep only multi-route, high-traffic clusters.
    You can tune min_total_trips / min_pairs as needed.
    """
    strong = summary[
        (summary["total_trip"] >= min_total_trips)
        & (summary["n_pairs"] >= min_pairs)
    ]
    return strong.index


# -------------------------------------------------------------------
# 4. Area labels (+ aliasing)
# -------------------------------------------------------------------
def area_label_from_zones(
    weighted_counts: pd.Series,
    zone_name: Callable[[int], str],
    borough_name: Callable[[int], str],
    max_zones: int = 3,
) -> tuple[str, list[str], str]:
    """
    Given a Series indexed by zone_id with trip_count weights,
    build a human-readable area label, a list of top zone names,
    and a coarse borough-area label.

    Return:
        (area_label, top_zone_names, borough_area_label)

    where:
        - area_label: short alias if we can infer one ("Midtown", "JFK", ...)
                      otherwise a fallback like "Manhattan area"
                      or "Union Sq, East Village".
        - top_zone_names: list of individual zone names, ordered by trip volume.
        - borough_area_label: "Manhattan area", "Queens area", etc., used
                              as a coarse fallback / debugging aid.
    """
    if weighted_counts.empty:
        return "Unknown area", [], "Unknown area"

    # Sort by trip_count descending
    sorted_counts = weighted_counts.sort_values(ascending=False)

    # Top zones (ids)
    top_zone_ids = sorted_counts.index.to_list()[:max_zones]
    top_zone_names = [zone_name(int(zid)) for zid in top_zone_ids]

    # Borough dominance (for coarse label)
    borough_counts: Dict[str, float] = {}
    for zid, trips in sorted_counts.items():
        b = borough_name(int(zid))
        borough_counts[b] = borough_counts.get(b, 0.0) + float(trips)

    borough_area_label = "Unknown area"
    if borough_counts:
        dom_borough, dom_trips = max(
            borough_counts.items(), key=lambda kv: kv[1]
        )
        total_trips = float(sorted_counts.sum())
        share = dom_trips / total_trips if total_trips > 0 else 0.0
        if dom_borough != "Unknown" and share >= 0.7:
            borough_area_label = f"{dom_borough} area"

    # 1) Try to get a *short* alias like "Midtown", "JFK", "Upper East Side".
    alias_label = pick_alias_from_zones(top_zone_names)

    if alias_label:
        area_label = alias_label
    else:
        # 2) Fallback: borough-based area if we have a strong dominant borough
        if borough_area_label != "Unknown area":
            area_label = borough_area_label
        else:
            # 3) Last resort: join top zone names.
            if top_zone_names:
                if len(top_zone_names) == 1:
                    area_label = top_zone_names[0]
                else:
                    area_label = ", ".join(top_zone_names[:2])
            else:
                area_label = "Mixed area"

    return area_label, top_zone_names, borough_area_label


# -------------------------------------------------------------------
# 5. Per-cluster semantics
# -------------------------------------------------------------------
def build_semantics_for_cluster(
    cluster_id: int,
    flows_df: pd.DataFrame,
    zone_name: Callable[[int], str],
    borough_name: Callable[[int], str],
) -> dict:
    """
    Build a semantic description for one cluster_id.
    Return a dict compatible with your HTML expectations, e.g.:

        {
            "label": "Midtown ↔ JFK",
            "top_zones": ["Times Sq/Theatre District", "JFK Airport", ...],
            "from_area": "Midtown",
            "to_area": "JFK",
            "from_borough_area": "Manhattan area",
            "to_borough_area": "Queens area",
            "total_trips": 123456,
            "n_pairs": 42,
        }
    """
    rows = flows_df[flows_df["flow_cluster_id"] == cluster_id]
    if rows.empty:
        return {}

    total_trips = int(rows["trip_count"].sum())

    # Unique OD pairs
    od_pairs = (
        rows.groupby(["origin_zone", "destination_zone"])
        .agg(pair_trips=("trip_count", "sum"))
        .reset_index()
    )
    n_pairs = int(len(od_pairs))

    # Weighted origin & dest distributions
    origins = rows.groupby("origin_zone")["trip_count"].sum()
    dests = rows.groupby("destination_zone")["trip_count"].sum()

    from_area, top_origin_zones, from_boro_area = area_label_from_zones(
        origins, zone_name, borough_name
    )
    to_area, top_dest_zones, to_boro_area = area_label_from_zones(
        dests, zone_name, borough_name
    )

    # Short corridor label for dropdowns / filters
    label = f"{from_area} ↔ {to_area}"

    # Combine top zones from both sides, dedupe while preserving order
    all_top_zones = top_origin_zones + top_dest_zones
    seen: set[str] = set()
    unique_top_zones: List[str] = []
    for z in all_top_zones:
        if z not in seen:
            seen.add(z)
            unique_top_zones.append(z)

    return {
        "label": label,
        "top_zones": unique_top_zones,
        "from_area": from_area,
        "to_area": to_area,
        "from_borough_area": from_boro_area,
        "to_borough_area": to_boro_area,
        "total_trips": total_trips,
        "n_pairs": n_pairs,
    }


# -------------------------------------------------------------------
# 6. CLI
# -------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Build semantic labels for flow_cluster_id from flows.csv"
    )
    parser.add_argument(
        "--flows",
        type=Path,
        required=True,
        help=(
            "Path to flows.csv (must contain flow_cluster_id, origin_zone, "
            "destination_zone, trip_count, time_bin)"
        ),
    )
    parser.add_argument(
        "--lookup",
        type=Path,
        default=None,
        help=(
            "Optional taxi_zone_lookup.csv for zone names and boroughs "
            "(LocationID, Zone, Borough)"
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("cluster_semantics.json"),
        help="Output JSON path (default: cluster_semantics.json)",
    )
    parser.add_argument(
        "--min_total_trips",
        type=int,
        default=5000,
        help=(
            "Minimum total trips per cluster to include in semantics "
            "(default: 5000)"
        ),
    )
    parser.add_argument(
        "--min_pairs",
        type=int,
        default=5,
        help=(
            "Minimum distinct origin/dest pairs per cluster "
            "(default: 5)"
        ),
    )

    args = parser.parse_args()

    print(f"Loading flows from {args.flows} ...")
    flows = load_flows(args.flows)

    print("Summarizing clusters ...")
    summary = summarize_clusters(flows)

    print(
        f"Total non-noise clusters: {len(summary)} "
        f"(min_total_trips={args.min_total_trips}, min_pairs={args.min_pairs})"
    )
    strong_ids = pick_strong_clusters(
        summary,
        min_total_trips=args.min_total_trips,
        min_pairs=args.min_pairs,
    )
    print(f"Selected {len(strong_ids)} strong clusters for semantics.")

    lookup_df = load_lookup(args.lookup) if args.lookup is not None else None
    zone_name, borough_name = make_zone_lookup(lookup_df)

    semantics: Dict[str, dict] = {}

    print("Building semantics for each strong cluster ...")
    for cid in strong_ids:
        cid_int = int(cid)
        info = build_semantics_for_cluster(cid_int, flows, zone_name, borough_name)
        if not info:
            continue
        # Use string keys so JSON keys are clean and consistent
        semantics[str(cid_int)] = info

    print(f"Writing semantics for {len(semantics)} clusters to {args.out} ...")
    args.out.write_text(json.dumps(semantics, indent=2), encoding="utf-8")
    print("Done.")


if __name__ == "__main__":
    main()