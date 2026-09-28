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
  tools/source/lambeth_cpz_timing_zones_raw.geojson
      Lambeth Council's "CPZ Timing Zones" layer (gis.lambeth.gov.uk, LambethCPZTimingZones/MapServer/0),
      requested in WGS84 and simplified to about 4 m by the server (maxAllowableOffset=0.00004).
  tools/source/lambeth_paybyphone_raw.geojson
      Lambeth Council's "CPZ Ticket Machines" layer (LambethCPZTicketMachines/MapServer/0): 510
      pay-by-phone locations with charging hours, days, maximum stay and tariff code.
  tools/source/tfl_bus_lanes_raw.geojson
      TfL's "Bus Lanes" open data layer (services1.arcgis.com/YswvgzOodUvqkoCN/.../Bus_Lanes/FeatureServer/0),
      live lanes within lat 51.404-51.501, lon -0.158 to -0.072: borough and TfL roads.

Outputs
  data/lambeth/school_streets.geojson   the dataset (edit this to fix a closure)
  data/lambeth/parking_zones.geojson    controlled parking zones with their hours
  data/lambeth/pay_by_phone.geojson     pay-by-phone locations
  data/lambeth/bus_lanes.geojson        bus lanes with hours, direction and permitted vehicles
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


CPZ_SRC = ROOT / "tools" / "source" / "lambeth_cpz_timing_zones_raw.geojson"
CPZ_OUT = ROOT / "data" / "lambeth" / "parking_zones.geojson"
CPZ_URL = "https://gis.lambeth.gov.uk/arcgis/rest/services/LambethCPZTimingZones/MapServer/0"


def build_parking():
    raw = json.loads(CPZ_SRC.read_text())
    feats = []
    for f in sorted(raw["features"], key=lambda f: f["properties"]["OBJECTID"]):
        a = f["properties"]
        oid = a["OBJECTID"]
        feats.append({
            "type": "Feature",
            "geometry": f["geometry"],
            "properties": {
                "id": f"LAM-CPZ-{oid:02d}",
                "zone": a["OVERALL_CPZ"],
                "timing_zone": a["TIMING_ZONE"],
                "code": a["OVERALL_CPZ_CODE"],
                "timings": a["TIMINGS"],
                "council_area_m2": round(a["SHAPE.AREA"]),
                "boundary_accuracy": "about 4 m (simplified)",
                "source": CPZ_URL,
                "updated": "2026-09-28",
            },
        })
    fc = {"type": "FeatureCollection", "name": "Lambeth controlled parking zones", "features": feats}
    CPZ_OUT.write_text(json.dumps(fc, indent=1))
    (WEB / "parking_zones.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    print(f"{len(feats)} parking zones")


PBP_SRC = ROOT / "tools" / "source" / "lambeth_paybyphone_raw.geojson"
PBP_URL = "https://gis.lambeth.gov.uk/arcgis/rest/services/LambethCPZTicketMachines/MapServer/0"
BUS_SRC = ROOT / "tools" / "source" / "tfl_bus_lanes_raw.geojson"
BUS_URL = "https://services1.arcgis.com/YswvgzOodUvqkoCN/arcgis/rest/services/Bus_Lanes/FeatureServer/0"


def build_pay_by_phone():
    raw = json.loads(PBP_SRC.read_text())
    feats = []
    for f in raw["features"]:
        a = f["properties"]
        if not f.get("geometry"):
            continue
        feats.append({
            "type": "Feature",
            "geometry": f["geometry"],
            "properties": {
                "code": str(a["PAYBYPHONE"]),
                "street": a["LOCATION_N"],
                "zone": a["ZONE"],
                "hours": a["CHARGING_T"],
                "days": a["DAYS"],
                "max_stay_h": a["MAX_STAY"],
                "tariff": a["TARIFF"],
                "machine": a["MACHINE"] == "Y",
                "on_street": a["ON_OFF_STR"] in ("On", "On-Street"),
                "source": PBP_URL,
            },
        })
    fc = {"type": "FeatureCollection", "name": "Lambeth pay-by-phone locations", "features": feats}
    out = ROOT / "data" / "lambeth" / "pay_by_phone.geojson"
    out.write_text(json.dumps(fc, indent=1))
    (WEB / "pay_by_phone.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    print(f"{len(feats)} pay-by-phone locations")


def build_bus_lanes():
    raw = json.loads(BUS_SRC.read_text())
    feats = []
    for f in raw["features"]:
        a = f["properties"]
        feats.append({
            "type": "Feature",
            "geometry": f["geometry"],
            "properties": {
                "id": "TFL-BL-" + a["FEATURE_ID"][:8],
                "road": a["ROAD_NAME"],
                "authority": a["BOROUGH"],
                "direction": a["DIRECTION"],      # direction of travel; line order is not reliable
                "side": a["CARRIAGEWAY"],
                "mon_fri": a["WEEK_DAYS"],
                "sat": a["SATURDAY"],
                "sun": a["SUNDAY"],
                "vehicles": a["VEHICLES"],
                "road_type": a["ROADTYPE"],
                "length_m": a["LENGTH"],
                "source": BUS_URL,
            },
        })
    fc = {"type": "FeatureCollection", "name": "Bus lanes in and around Lambeth (TfL)", "features": feats}
    out = ROOT / "data" / "lambeth" / "bus_lanes.geojson"
    out.write_text(json.dumps(fc, indent=1))
    (WEB / "bus_lanes.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    print(f"{len(feats)} bus lanes")


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
    build_parking()
    build_pay_by_phone()
    build_bus_lanes()
