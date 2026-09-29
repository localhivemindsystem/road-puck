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
  tools/source/tfl_speed_limits_raw.json   TfL's London speed limit map for the test area (Speed_Limits_Feedback/FeatureServer/10,
      "Speed_Limits_Processed_20260211"): 39,429 segments. Overrides OpenStreetMap limits where they line up.
  tools/source/tfl_yellow_boxes_raw.geojson TfL yellow box junctions (TfL_Yellow_box_junctions/FeatureServer/4)
  data/lambeth/parking_apps.json           which app pays for street bays and car parks, and how to open each app
  data/lambeth/ringgo_car_parks.json       RingGo car parks in Lambeth, copied by hand from the RingGo parking locator
  data/lambeth/ringgo_street_bays.json     Wandsworth street bays paid with RingGo, near the Lambeth border (same source)
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
  data/lambeth/car_parks.geojson        car parks you pay for with an app (RingGo)
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
                "app": "paybyphone",
                "borough": "Lambeth",
                "source": PBP_URL,
            },
        })
    n_lambeth = len(feats)
    # neighbouring councils' street bays sold through RingGo (hand-copied from the RingGo locator)
    rg = json.loads((ROOT / "data" / "lambeth" / "ringgo_street_bays.json").read_text())
    for b in rg["bays"]:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [b["lng"], b["lat"]]},
            "properties": {
                "code": b["code"], "street": b["street"], "zone": b["zone"], "hours": b["hours"], "days": b["days"],
                "max_stay_h": b["max_stay_h"], "tariff": b["tariff"], "machine": False, "on_street": True,
                "app": "ringgo", "borough": b["borough"], "source": rg["source"], "checked": rg["checked"],
                **({"note": b["note"]} if b.get("note") else {}),
                **({"check_hours": b["check_hours"]} if b.get("check_hours") else {}),
            },
        })
    fc = {"type": "FeatureCollection", "name": "Pay-by-phone street parking locations", "features": feats}
    out = ROOT / "data" / "lambeth" / "pay_by_phone.geojson"
    out.write_text(json.dumps(fc, indent=1))
    (WEB / "pay_by_phone.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    print(f"{n_lambeth} Lambeth pay-by-phone locations + {len(feats) - n_lambeth} RingGo street bays next door")


def build_car_parks():
    src = json.loads((ROOT / "data" / "lambeth" / "ringgo_car_parks.json").read_text())
    feats = []
    for s in src["sites"]:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s["lng"], s["lat"]]},
            "properties": {
                "code": str(s["code"]), "app": "ringgo", "name": s["name"], "operator": s.get("operator", ""),
                "area": s.get("area", ""), "max_stay": s.get("max_stay", ""), "price": s.get("price", ""),
                "note": s.get("note", ""), "info_url": s.get("info_url", ""),
                **({"hours": s["hours"], "days": s["days"], "free_days": s.get("free_days", "")} if s.get("hours") else {}),
                "kind": "car park", "source": src["source"], "checked": src["checked"],
            },
        })
    fc = {"type": "FeatureCollection", "name": "Lambeth app-paid car parks", "features": feats}
    (ROOT / "data" / "lambeth" / "car_parks.geojson").write_text(json.dumps(fc, indent=1))
    (WEB / "car_parks.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    print(f"{len(feats)} RingGo car parks")


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


TFL_SPEED_SRC = ROOT / "tools" / "source" / "tfl_speed_limits_raw.json"


def _norm_name(n):
    n = (n or "").lower().replace("'", "")
    for a, b in ((" rd", " road"), (" st", " street"), (" ave", " avenue"), (" ln", " lane")):
        if n.endswith(a):
            n = n[: -len(a)] + b
    return " ".join(n.split())


def apply_tfl_speed_limits(src):
    """Replace OpenStreetMap speed limits with TfL's London speed limit map where the two line up.

    TfL's layer (Speed_Limits_Feedback, "Speed_Limits_Processed") combines Ordnance Survey, OpenStreetMap,
    borough and TfL records on the OS road network, and is more up to date than OpenStreetMap (for example
    the A23 Streatham High Road, now 20 mph). Each street in our map is sampled every ~10 m; each sample takes
    the limit of the nearest TfL segment running the same way within 12 m (same road name preferred), and the
    street takes the most common answer. Streets with no TfL match keep their OpenStreetMap limit.
    """
    if not TFL_SPEED_SRC.exists():
        return {}
    import math
    from collections import Counter, defaultdict
    t = json.loads(TFL_SPEED_SRC.read_text())
    names = [_norm_name(n) for n in t["names"]]
    CELL = 40.0
    grid = defaultdict(list)
    for lim, conf, tlrn, ni, osm, paths in t["rows"]:
        if lim not in UK_MPH:
            continue
        for path in paths:
            X = Y = 0
            pts = []
            for i in range(0, len(path), 2):
                X += path[i]; Y += path[i + 1]
                lon, lat = X / 1e6, Y / 1e6
                pts.append(((lon - LON0) * KX, (lat - LAT0) * KY))
            for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                seg = (x1, y1, x2, y2, lim, names[ni])
                for cx in range(int(math.floor(min(x1, x2) / CELL)), int(math.floor(max(x1, x2) / CELL)) + 1):
                    for cy in range(int(math.floor(min(y1, y2) / CELL)), int(math.floor(max(y1, y2) / CELL)) + 1):
                        grid[(cx, cy)].append(seg)

    def near(x, y, brg, name):
        best = best_named = None
        cx, cy = int(math.floor(x / CELL)), int(math.floor(y / CELL))
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for x1, y1, x2, y2, lim, nm in grid.get((gx, gy), ()):
                    dx, dy = x2 - x1, y2 - y1
                    L2 = dx * dx + dy * dy or 1e-9
                    u = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                    d = math.hypot(x1 + u * dx - x, y1 + u * dy - y)
                    if d > 12:
                        continue
                    b = math.degrees(math.atan2(dx, dy)) % 180
                    diff = abs(b - brg) % 180
                    if min(diff, 180 - diff) > 35:
                        continue
                    if best is None or d < best[0]:
                        best = (d, lim)
                    if name and nm == name and (best_named is None or d < best_named[0]):
                        best_named = (d, lim)
        if best_named:
            return best_named[1]
        return best[1] if best and best[0] <= 8 else None

    changes = Counter()
    matched = 0
    for w in src["ways"]:
        x = y = 0
        pts = []
        for i in range(4, len(w), 2):
            x += w[i]; y += w[i + 1]
            pts.append((x, y))
        name = _norm_name(src["names"][w[1]]) if w[1] is not None and w[1] >= 0 else ""
        votes = Counter()
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            seg = math.hypot(x2 - x1, y2 - y1)
            if seg < 0.5:
                continue
            brg = math.degrees(math.atan2(x2 - x1, y2 - y1)) % 180
            n = max(1, int(seg // 10))
            for k in range(n):
                f = (k + 0.5) / n
                lim = near(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, brg, name)
                if lim:
                    votes[lim] += 1
        if votes:
            matched += 1
            new = votes.most_common(1)[0][0]
            if new < 20 or (w[3] and w[3] < 20):   # 5/10 mph: private and estate roads, where OpenStreetMap is better
                continue
            if new != w[3]:
                changes[(w[3], new)] += 1
                w[3] = new
    return {"matched": matched, "changes": changes}


def build_streets():
    src = json.loads((ROOT / "tools" / "source" / "osm_streets_v2.json").read_text())
    for w in src["ways"]:
        if w[3] == 12:   # "20" tagged without units reads as 20 km/h; in London it means 20 mph
            w[3] = 20
        elif w[3] and w[3] not in UK_MPH:
            w[3] = 0
    tfl = apply_tfl_speed_limits(src)
    if tfl:
        ch = tfl["changes"]
        print(f"TfL speed limits matched {tfl['matched']} of {len(src['ways'])} streets; changed {sum(ch.values())}: "
              + ", ".join(f"{a or '?'}->{b}: {n}" for (a, b), n in ch.most_common(8)))
    base = {k: src[k] for k in ("v", "origin", "src", "fetched", "classes", "names", "ways", "boundary")}
    base["format"] = "ways: [class, nameIndex, oneway, maxspeed_mph (0 = unknown), dx, dy, ...] metres, delta-encoded"
    if tfl:
        base["speed_src"] = "TfL speed limit map (Speed_Limits_Processed_20260211, fetched 2026-09-29) where matched, else OpenStreetMap"
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
    for name in ("term_dates.json", "parking_apps.json"):
        shutil.copy(ROOT / "data" / "lambeth" / name, WEB / name)
    print(f"{len(feats)} School Streets, {sum(f['properties']['placement'] == 'check' for f in feats)} to check")


if __name__ == "__main__":
    build()
    build_parking()
    build_pay_by_phone()
    build_car_parks()
    build_bus_lanes()
    build_streets()
