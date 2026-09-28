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
  tools/source/osm_streets_v2.json
      Lambeth street network from OpenStreetMap (see tools/basemap_query.overpassql), processed in the
      browser: ways as [class, nameIndex, oneway, maxspeed_mph, dx, dy, ...] in metres from lon -0.115,
      lat 51.455; oneway=-1 streets reversed, roundabouts one-way. "restr" lists ways closed to private
      cars: [wayIndex, type, whenIndex, osmWayId], type 1 no motor vehicles, 2 bus gate, 3 pedestrian zone,
      4 timed restriction (whens[whenIndex] is the OSM :conditional value).
  tools/source/osm_speed_cameras.json      speed/red-light cameras mapped in OpenStreetMap
  tools/source/tfl_yellow_boxes_raw.geojson TfL yellow box junctions (TfL_Yellow_box_junctions/FeatureServer/4)
  data/lambeth/parking_app.json            which pay-by-phone app the borough uses and how to open it
  data/lambeth/restriction_checks.json     your on-the-ground checks: {"osm way id": {"verified": true, "note": ""}}
  tools/source/tfl_bus_lanes_raw.geojson
      TfL's "Bus Lanes" open data layer (services1.arcgis.com/YswvgzOodUvqkoCN/.../Bus_Lanes/FeatureServer/0),
      live lanes within lat 51.404-51.501, lon -0.158 to -0.072: borough and TfL roads.

Outputs
  data/lambeth/school_streets.geojson   the dataset (edit this to fix a closure)
  data/lambeth/parking_zones.geojson    controlled parking zones with their hours
  data/lambeth/pay_by_phone.geojson     pay-by-phone locations
  data/lambeth/bus_lanes.geojson        bus lanes with hours, direction and permitted vehicles
  data/lambeth/basemap.json             street map with speed limits and one-way directions (v2)
  data/lambeth/restrictions.geojson     no entry, bus gates, pedestrian zones and timed restrictions
  data/lambeth/cameras.geojson          speed and red-light cameras
  data/lambeth/yellow_boxes.geojson     yellow box junctions
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


import math

LON0, LAT0 = -0.115, 51.455
KX, KY = math.cos(math.radians(LAT0)) * 111320, 110540
UK_MPH = {5, 10, 15, 20, 30, 40, 50, 60, 70}
RESTR_TYPES = {1: "NO MOTOR VEHICLES", 2: "BUS GATE", 3: "PEDESTRIAN ZONE", 4: "TIMED NO ENTRY"}
OSM = "OpenStreetMap contributors (ODbL)"


def way_points(w):
    x = y = 0
    pts = []
    for i in range(4, len(w), 2):
        x += w[i]; y += w[i + 1]
        pts.append([round(LON0 + x / KX, 6), round(LAT0 + y / KY, 6)])
    return pts


def build_streets():
    src = json.loads((ROOT / "tools" / "source" / "osm_streets_v2.json").read_text())
    for w in src["ways"]:
        if w[3] == 12:   # "20" tagged without units reads as 20 km/h; in London it means 20 mph
            w[3] = 20
        elif w[3] and w[3] not in UK_MPH:
            w[3] = 0
    base = {k: src[k] for k in ("v", "origin", "src", "fetched", "classes", "names", "ways", "boundary")}
    base["format"] = "ways: [class, nameIndex, oneway, maxspeed_mph (0 = unknown), dx, dy, ...] metres, delta-encoded"
    (ROOT / "data" / "lambeth" / "basemap.json").write_text(json.dumps(base, separators=(",", ":")))
    shutil.copy(ROOT / "data" / "lambeth" / "basemap.json", WEB / "basemap.json")

    checks_file = ROOT / "data" / "lambeth" / "restriction_checks.json"
    if not checks_file.exists():
        checks_file.write_text(json.dumps({"_help": "Add entries like \"123456\": {\"verified\": true, \"note\": \"sign seen 2026-10-01\"}. "
                                                    "Use \"verified\": false to switch an alert off."}, indent=1))
    checks = json.loads(checks_file.read_text())
    feats = []
    for wi, typ, when_i, osm_id in src["restr"]:
        w = src["ways"][wi]
        chk = checks.get(str(osm_id), {})
        if chk.get("verified") is False:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": way_points(w)},
            "properties": {
                "id": f"OSM-{osm_id}",
                "osm_way": osm_id,
                "kind": RESTR_TYPES[typ],
                "road": src["names"][w[1]] or "",
                "when": src["whens"][when_i] if when_i >= 0 else "",
                "verified": bool(chk.get("verified")),
                "note": chk.get("note", ""),
                "source": OSM,
            },
        })
    fc = {"type": "FeatureCollection", "name": "Access restrictions (OpenStreetMap, unverified)", "features": feats}
    (ROOT / "data" / "lambeth" / "restrictions.geojson").write_text(json.dumps(fc, indent=1))
    (WEB / "restrictions.geojson").write_text(json.dumps(fc, separators=(",", ":")))

    cams = json.loads((ROOT / "tools" / "source" / "osm_speed_cameras.json").read_text())
    cfeats = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
        "properties": {"id": c["osm"].replace("/", "-").upper(), "type": "red light" if c["type"] == "traffic_signals" else "speed",
                       "maxspeed": c.get("maxspeed"), "direction": c.get("direction"), "osm": c["osm"], "source": OSM},
    } for c in cams]
    fc = {"type": "FeatureCollection", "name": "Safety cameras (OpenStreetMap)", "features": cfeats}
    (ROOT / "data" / "lambeth" / "cameras.geojson").write_text(json.dumps(fc, indent=1))
    (WEB / "cameras.geojson").write_text(json.dumps(fc, separators=(",", ":")))

    yb = json.loads((ROOT / "tools" / "source" / "tfl_yellow_boxes_raw.geojson").read_text())
    yfeats = [{
        "type": "Feature",
        "geometry": f["geometry"],
        "properties": {"id": f"TFL-YBJ-{f['properties']['OBJECTID']}", "junction": f["properties"]["STREET_NAME"],
                       "from": f["properties"].get("START_LOCATION"), "to": f["properties"].get("FINISH_LOCATION"),
                       "source": "https://services1.arcgis.com/YswvgzOodUvqkoCN/arcgis/rest/services/TfL_Yellow_box_junctions/FeatureServer/4"},
    } for f in yb["features"] if f.get("geometry")]
    fc = {"type": "FeatureCollection", "name": "Yellow box junctions (TfL)", "features": yfeats}
    (ROOT / "data" / "lambeth" / "yellow_boxes.geojson").write_text(json.dumps(fc, indent=1))
    (WEB / "yellow_boxes.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    known = sum(1 for w in base["ways"] if w[3])
    print(f"{len(base['ways'])} streets ({known} with a speed limit), {len(feats)} restrictions, {len(cfeats)} cameras, {len(yfeats)} yellow boxes")


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
    for name in ("term_dates.json", "parking_app.json"):
        shutil.copy(ROOT / "data" / "lambeth" / name, WEB / name)
    print(f"{len(feats)} School Streets, {sum(f['properties']['placement'] == 'check' for f in feats)} to check")


if __name__ == "__main__":
    build()
    build_parking()
    build_pay_by_phone()
    build_bus_lanes()
    build_streets()
