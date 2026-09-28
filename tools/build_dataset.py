#!/usr/bin/env python3
"""Build the Lambeth School Streets dataset and copy all data into the web app.

Run from the repo root:  python3 tools/build_dataset.py

Inputs
  tools/source/lambeth_school_streets_geocoded.json
      One row per School Street:
      [school, road, am_window, pm_window, school_to_street_m, anchor_source, [lon, lat], segments]
      Times were copied from Lambeth Council's "School Streets times and locations" page.
      Segments are OpenStreetMap street lines within 150 m of the point on the road
      nearest the school (located with OpenStreetMap's Nominatim search).
  data/lambeth/term_dates.json
  data/lambeth/basemap.json   (street map, see tools/basemap_query.overpassql)

Outputs
  data/lambeth/school_streets.geojson   the dataset (edit this to fix a closure)
  docs/data/*                           copies the phone app loads
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "source" / "lambeth_school_streets_geocoded.json"
OUT = ROOT / "data" / "lambeth" / "school_streets.geojson"
WEB = ROOT / "docs" / "data"

ABBR = {"Road": "RD", "Street": "ST", "Lane": "LN", "Gardens": "GDNS", "Grove": "GR",
        "Close": "CL", "Avenue": "AVE", "Court": "CT", "Place": "PL", "Crescent": "CRES"}

COUNCIL_URL = "https://www.lambeth.gov.uk/streets-roads-transport/school-streets/school-streets-times-locations"


def short(road):
    return " ".join(ABBR.get(w, w) for w in road.split()).upper()


def build():
    rows = json.loads(SRC.read_text())
    feats = []
    for i, (school, road, am, pm, gap, anchor_src, anchor, segs) in enumerate(rows, 1):
        approximate = gap > 150 or anchor_src != "school"
        feats.append({
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": segs},
            "properties": {
                "id": f"LAM-SS-{i:02d}",
                "kind": "SCHOOL STREET",
                "borough": "Lambeth",
                "road": road,
                "road_short": short(road),
                "school": school,
                "windows": [am, pm],
                "days": "Mon-Fri",
                "term_time_only": True,
                "enforcement": "ANPR camera, PCN code 53J",
                "anchor": anchor,
                "placement": "check" if approximate else "near school",
                "school_to_street_m": gap,
                "verified_on_ground": False,
                "times_source": COUNCIL_URL,
                "geometry_source": "OpenStreetMap contributors (ODbL)",
                "updated": "2026-09-28",
            },
        })
    fc = {"type": "FeatureCollection", "name": "Lambeth School Streets", "features": feats}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fc, indent=1))
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "school_streets.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    for name in ("basemap.json", "term_dates.json"):
        shutil.copy(ROOT / "data" / "lambeth" / name, WEB / name)
    print(f"{len(feats)} School Streets, {sum(f['properties']['placement'] == 'check' for f in feats)} to check")


if __name__ == "__main__":
    build()
