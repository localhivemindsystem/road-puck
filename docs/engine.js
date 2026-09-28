/* Road Puck alert engine.
   Pure logic, no page code: positions in, one alert out.
   Used by the phone app (docs/index.html) and by tools/test_engine.js.

   Layers it understands:
     School Streets  timed closures (lines)           -> X, C, W, O
     One-way streets from the street map (lines)      -> R (wrong way), E (no entry ahead)
     Bus lanes       TfL lines with hours + direction -> C (in force), W (starts soon), O (not in force), kind BUS LANE
     Parking zones   CPZ polygons with hours          -> P (permit or pay now), F (free now)  -- only when parked
     Restrictions    OSM bus gates, no motor vehicles, pedestrian zones, timed no entry -> X (on it), E (ahead), W, O
     Cameras         OSM speed / red-light cameras    -> S
     Yellow boxes    TfL box junctions                -> Y
     Every alert also carries limit (mph), mph and over (0 ok, 1 over, 2 well over). */
(function (root) {
  'use strict';

  // ---- local metric grid centred on Lambeth ----
  const LON0 = -0.115, LAT0 = 51.455;
  const KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KY = 110540;
  const toM = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const toLL = (x, y) => [LON0 + x / KX, LAT0 + y / KY];
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  // ================= School Streets =================
  function loadFeatures(geojson) {
    return geojson.features.map(f => {
      const p = f.properties;
      const segs = f.geometry.coordinates.map(s => s.map(([lon, lat]) => toM(lon, lat)));
      return {
        ...p,
        segs,
        anchorM: toM(p.anchor[0], p.anchor[1]),
        win: p.windows.map(w => w.split('-').map(hm)),
      };
    });
  }

  function hm(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
  function fmt(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }

  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1);
    t = Math.max(0, Math.min(1, t));
    const x = a[0] + t * dx, y = a[1] + t * dy;
    return { d: Math.hypot(x - p[0], y - p[1]), pt: [x, y] };
  }

  function nearest(f, p) {
    let best = Infinity, pt = null;
    for (const s of f.segs) {
      for (let i = 0; i < s.length - 1; i++) {
        const r = segDist(p, s[i], s[i + 1]);
        if (r.d < best) { best = r.d; pt = r.pt; }
      }
    }
    return { d: best, pt };
  }

  // ---- time ----
  function londonNow(date) {
    const d = date || new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = t => parts.find(x => x.type === t).value;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
      date: `${g('year')}-${g('month')}-${g('day')}`,
      day: days.indexOf(g('weekday')),
      min: (Number(g('hour')) % 24) * 60 + Number(g('minute')),
    };
  }

  function inTerm(dateStr, terms) {
    return terms.some(([a, b]) => dateStr >= a && dateStr <= b);
  }

  // clock = { day: 0-6 (Sun=0), min: minutes since midnight, term: true/false }
  function status(f, clock) {
    if (!clock.term) return { k: 'open', allDay: true, why: 'SCHOOL HOLIDAYS' };
    if (clock.day === 0 || clock.day === 6) return { k: 'open', allDay: true, why: 'WEEKEND' };
    for (const [a, b] of f.win) {
      if (clock.min >= a && clock.min < b) return { k: 'closed', until: b };
    }
    const next = f.win.map(w => w[0]).find(a => a > clock.min);
    if (next !== undefined && next - clock.min <= 30) return { k: 'closing', at: next, inMin: next - clock.min };
    return { k: 'open', next };
  }

  // ================= Parking zones (CPZ) =================
  // Council timing text, e.g. "Mon-Fri 0830-1830; Sat 0830-1330", "Mon-Sat 0830-1730 or 2030",
  // "Sun-Fri 0830-1830", "Mon-Fri 0830-1830; Residents Only 0830-2030".
  const DAYN = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  function parseTimings(text) {
    const rules = [];
    let lastDays = null;
    for (let seg of String(text).split(';')) {
      seg = seg.trim();
      if (!seg) continue;
      let label = '';
      const lm = seg.match(/^residents only\s*/i);
      if (lm) { label = 'RESIDENTS ONLY'; seg = seg.slice(lm[0].length); }
      let days = lastDays;
      const dm = seg.match(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s*-\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*)?/i);
      if (dm) {
        const a = DAYN[dm[1].toLowerCase()], b = dm[2] ? DAYN[dm[2].toLowerCase()] : a;
        days = [];
        for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
        seg = seg.slice(dm[0].length);
      }
      const tm = seg.match(/(\d{3,4})\s*-\s*(\d{3,4})(?:\s*or\s*(\d{3,4}))?/i);
      if (!tm || !days) continue;
      const t = x => { x = x.padStart(4, '0'); return Number(x.slice(0, 2)) * 60 + Number(x.slice(2)); };
      rules.push({ days, start: t(tm[1]), end: t(tm[2]), endAlt: tm[3] ? t(tm[3]) : null, label });
      lastDays = days;
    }
    return rules;
  }

  function loadZones(geojson) {
    return geojson.features.map((f, i) => {
      const g = f.geometry;
      const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(poly => poly.map(ring => ring.map(([lon, lat]) => toM(lon, lat))));
      let area = 0, cx = 0, cy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const poly of polys) {
        const r = poly[0];
        for (let k = 0; k < r.length - 1; k++) {
          const c = r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
          area += c; cx += (r[k][0] + r[k + 1][0]) * c; cy += (r[k][1] + r[k + 1][1]) * c;
        }
        for (const ring of poly) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      const p = f.properties;
      return {
        id: p.id || 'ZONE-' + i, zone: p.zone, code: p.code, name: p.timing_zone || p.zone, timings: p.timings,
        rules: parseTimings(p.timings), polys, area: Math.abs(area / 2),
        centre: area ? [cx / (3 * area), cy / (3 * area)] : [(x0 + x1) / 2, (y0 + y1) / 2],
        bbox: [x0, y0, x1, y1],
      };
    });
  }

  function inRing(p, r) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  }
  function inZone(z, p) {
    const b = z.bbox;
    if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) return false;
    return z.polys.some(poly => inRing(p, poly[0]) && !poly.slice(1).some(h => inRing(p, h)));
  }
  function edgeDist(z, p) {
    let d = Infinity;
    for (const poly of z.polys) for (const r of poly) for (let i = 0; i < r.length - 1; i++) d = Math.min(d, segDist(p, r[i], r[i + 1]).d);
    return d;
  }

  // What the zone's rules say right now.
  function zoneStatus(z, clock) {
    let gen = null, alt = null, res = null;
    for (const r of z.rules) {
      if (!r.days.includes(clock.day) || clock.min < r.start) continue;
      if (r.label) { if (clock.min < r.end) res = Math.max(res || 0, r.end); continue; }
      if (clock.min < r.end) gen = Math.max(gen || 0, r.end);
      if (r.endAlt && clock.min < r.endAlt) alt = Math.max(alt || 0, r.endAlt);
    }
    if (gen != null) return { k: 'controlled', until: gen, untilAlt: alt && alt > gen ? alt : null, thenResidents: res && res > gen ? res : null };
    if (alt != null) return { k: 'controlled', until: alt, some: true };
    if (res != null) return { k: 'controlled', until: res, residents: true };
    for (let i = 0; i < 8; i++) {  // next time controls start
      const day = (clock.day + i) % 7;
      const starts = z.rules.filter(r => r.days.includes(day) && (i > 0 || r.start > clock.min)).map(r => r.start);
      if (starts.length) return { k: 'free', from: { day, min: Math.min(...starts), today: i === 0 } };
    }
    return { k: 'none' };
  }

  function parkingAt(zones, p, clock) {
    const hits = zones.filter(z => inZone(z, p)).sort((a, b) => a.area - b.area);  // most specific first
    if (!hits.length) return { k: 'none' };
    const z = hits[0];
    return { z, ...zoneStatus(z, clock), edge: edgeDist(z, p) };
  }

  function whenText(st) {
    if (st.k === 'controlled') {
      if (st.some) return `SOME STREETS UNTIL ${fmt(st.until)}`;
      let t = `UNTIL ${fmt(st.until)}`;
      if (st.untilAlt) t += ` (SOME STREETS ${fmt(st.untilAlt)})`;
      if (st.thenResidents) t += `, THEN RESIDENTS ONLY TO ${fmt(st.thenResidents)}`;
      return t;
    }
    if (st.k === 'free') return st.from.today ? `UNTIL ${fmt(st.from.min)}` : `UNTIL ${DAYS[st.from.day]} ${fmt(st.from.min)}`;
    return '';
  }

  // ================= Street network (one-way streets) =================
  // base = the app's basemap.json: ways as [class, nameIndex, oneway, dx, dy, ...] in metres.
  const CELL = 60;
  function loadRoads(base) {
    const ways = [], grid = new Map();
    const key = (i, j) => i * 100000 + j;
    const off = base.v >= 2 ? 4 : 3;  // v2 adds the speed limit
    base.ways.forEach((w, wi) => {
      const pts = [];
      let x = 0, y = 0;
      for (let i = off; i < w.length; i += 2) { x += w[i]; y += w[i + 1]; pts.push([x, y]); }
      ways.push({ cls: w[0], name: base.names[w[1]] || '', oneway: w[2] === 1, limit: off === 4 ? w[3] || 0 : 0, pts });
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const i0 = Math.floor(Math.min(a[0], b[0]) / CELL), i1 = Math.floor(Math.max(a[0], b[0]) / CELL);
        const j0 = Math.floor(Math.min(a[1], b[1]) / CELL), j1 = Math.floor(Math.max(a[1], b[1]) / CELL);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([wi, s]);
        }
      }
    });
    return { ways, grid, key };
  }

  // Which street is this position on? Uses distance plus how well the street lines up with the direction of travel.
  function matchRoad(roads, p, heading, maxD) {
    const { grid, key, ways } = roads;
    const i0 = Math.floor((p[0] - maxD) / CELL), i1 = Math.floor((p[0] + maxD) / CELL);
    const j0 = Math.floor((p[1] - maxD) / CELL), j1 = Math.floor((p[1] + maxD) / CELL);
    let best = null;
    const seen = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const [wi, s] of grid.get(key(i, j)) || []) {
        const id = wi * 10000 + s;
        if (seen.has(id)) continue;
        seen.add(id);
        const w = ways[wi], a = w.pts[s], b = w.pts[s + 1];
        const r = segDist(p, a, b);
        if (r.d > maxD) continue;
        const brg = bearing(a, b);
        let score = r.d;
        if (heading != null) { const ad = angleDiff(heading, brg); score += 0.3 * Math.min(ad, 180 - ad); }
        if (!best || score < best.score) best = { wi, s, d: r.d, bearing: brg, score, way: w };
      }
    }
    return best;
  }

  // Nearest street that has a name (for labelling unnamed restrictions).
  function nearestNamed(roads, p, maxD) {
    const { grid, key, ways } = roads;
    let best = null;
    for (let i = Math.floor((p[0] - maxD) / CELL); i <= Math.floor((p[0] + maxD) / CELL); i++)
      for (let j = Math.floor((p[1] - maxD) / CELL); j <= Math.floor((p[1] + maxD) / CELL); j++)
        for (const [wi, s2] of grid.get(key(i, j)) || []) {
          const w = ways[wi];
          if (!w.name) continue;
          const d = segDist(p, w.pts[s2], w.pts[s2 + 1]).d;
          if (d <= maxD && (!best || d < best.d)) best = { name: w.name, d };
        }
    return best;
  }

  // ================= Bus lanes (TfL) =================
  // Hours text per day group: "24 Hours (All Day)", "Not in Operation", "07:00-10:00, 16:00-19:00".
  function parseHours(text) {
    const t = String(text || '');
    if (/24 hours/i.test(t)) return [[0, 1440]];
    if (/not in operation/i.test(t)) return [];
    return [...t.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)].map(m => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  }
  const COMPASS = { 'North': 0, 'North East': 45, 'East': 90, 'South East': 135, 'South': 180, 'South West': 225, 'West': 270, 'North West': 315 };

  function loadBusLanes(geojson) {
    return geojson.features.map(f => {
      const p = f.properties;
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const pts = lines.map(l => l.map(([lon, lat]) => toM(lon, lat)));
      const dir = COMPASS[p.direction];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.flat().forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
      return { ...p, lines: pts, dir, bbox: [x0, y0, x1, y1],
        hours: { wk: parseHours(p.mon_fri), sat: parseHours(p.sat), sun: parseHours(p.sun) } };
    }).filter(l => l.hours.wk.length || l.hours.sat.length || l.hours.sun.length);
  }
  const laneDay = (l, day) => day === 0 ? l.hours.sun : day === 6 ? l.hours.sat : l.hours.wk;

  function busStatus(l, clock) {
    const today = laneDay(l, clock.day);
    for (const [a, b] of today) {
      if (clock.min >= a && clock.min < b) return { k: 'closed', until: b, allDay: a === 0 && b === 1440 };
    }
    const next = today.map(w => w[0]).filter(a => a > clock.min).sort((a, b) => a - b)[0];
    if (next !== undefined && next - clock.min <= 15) return { k: 'closing', at: next, inMin: next - clock.min };
    return { k: 'open', next };
  }

  // Is the car on (or about to join) a bus lane's road, travelling the lane's way?
  function matchBusLane(lanes, p, heading, maxD) {
    let best = null;
    for (const l of lanes) {
      const b = l.bbox;
      if (p[0] < b[0] - maxD || p[0] > b[2] + maxD || p[1] < b[1] - maxD || p[1] > b[3] + maxD) continue;
      for (const line of l.lines) for (let i = 0; i < line.length - 1; i++) {
        const r = segDist(p, line[i], line[i + 1]);
        if (r.d > maxD) continue;
        let brg = bearing(line[i], line[i + 1]);
        if (l.dir != null && angleDiff(brg, l.dir) > 90) brg = (brg + 180) % 360;  // travel direction, not drawing order
        if (heading != null && angleDiff(heading, brg) > 40) continue;
        if (!best || r.d < best.d) best = { l, d: r.d };
      }
    }
    return best;
  }

  // ================= Pay-by-phone =================
  // Council text, e.g. hours "08:30-18:30,Sa 08:30-13:00" / "8.30am - 6.30pm" / "10am - 12pm", days "Monday - Friday".
  function parseClock(t) {
    const m = String(t).trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2})|(\d{2}))?\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]), min = Number(m[2] || m[3] || 0);
    if (m[4] === 'pm' && h < 12) h += 12;
    if (m[4] === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }
  function parsePayHours(hours, days) {
    const out = { rules: [], ok: true };
    let base = [1, 2, 3, 4, 5];
    const dm = String(days || '').match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*-\s*(mon|tue|wed|thu|fri|sat|sun)/i);
    if (dm) { const a = DAYN[dm[1].toLowerCase()], b = DAYN[dm[2].toLowerCase()]; base = []; for (let d = a; ; d = (d + 1) % 7) { base.push(d); if (d === b) break; } }
    else out.ok = false;
    for (let seg of String(hours || '').split(',')) {
      seg = seg.trim();
      let dd = base;
      const sm = seg.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]*\s+/i);
      if (sm) { dd = [OSM_DAY[sm[1][0].toUpperCase() + sm[1][1].toLowerCase()]]; seg = seg.slice(sm[0].length); }
      const parts = seg.split('-');
      const a = parts.length === 2 ? parseClock(parts[0]) : null, b = parts.length === 2 ? parseClock(parts[1]) : null;
      if (a == null || b == null || a < 5 * 60 || b <= a) { out.ok = false; continue; }  // "0-17:30" and the like
      if (sm) out.rules.push({ days: dd, ranges: [[a, b]] });
      else { out.rules.push({ days: dd.filter(d => d !== 6 || !/sa/i.test(hours)), ranges: [[a, b]] }); }
    }
    if (!out.rules.length) out.ok = false;
    return out;
  }
  function payStatus(pt, clock) {
    if (!pt.rules.ok) return { k: 'unknown' };
    for (const r of pt.rules.rules) if (r.days.includes(clock.day)) for (const [a, b] of r.ranges) if (clock.min >= a && clock.min < b) return { k: 'pay', until: b };
    for (let i = 0; i < 8; i++) {
      const day = (clock.day + i) % 7;
      const starts = pt.rules.rules.filter(r => r.days.includes(day)).flatMap(r => r.ranges.map(x => x[0])).filter(a => i > 0 || a > clock.min);
      if (starts.length) return { k: 'free', from: { day, min: Math.min(...starts), today: i === 0 } };
    }
    return { k: 'free' };
  }
  function priceText(tariff) {
    const m = String(tariff || '').match(/^(\d+(?:\.\d+)?)ph$/i);
    return m ? `\u00a3${Number(m[1]).toFixed(2).replace(/\.00$/, '')}/H` : '';
  }
  function loadPayByPhone(geojson) {
    return geojson.features.map(f => ({ ...f.properties, m: toM(f.geometry.coordinates[0], f.geometry.coordinates[1]), rules: parsePayHours(f.properties.hours, f.properties.days) }));
  }
  // App-paid car parks (RingGo locator): off-street, so never shown as the street's rule.
  function loadCarParks(geojson) {
    return geojson.features.map(f => ({ ...f.properties, m: toM(f.geometry.coordinates[0], f.geometry.coordinates[1]) }));
  }
  // Which app pays for a place: apps file {on_street, apps:{key:{name,...}}}; older single-app files still work.
  function appFor(apps, key) {
    if (apps && apps.apps) return apps.apps[key || apps.on_street] || apps.apps[apps.on_street] || { name: key || 'PayByPhone' };
    return apps || { name: 'PayByPhone' };
  }
  function nearestPayByPhone(points, p, maxD = 150) {
    let best = null;
    for (const pt of points) {
      const d = Math.hypot(pt.m[0] - p[0], pt.m[1] - p[1]);
      if (d <= maxD && (!best || d < best.d)) best = { ...pt, d };
    }
    return best;
  }

  // ================= Access restrictions (OpenStreetMap) =================
  // OSM conditional text, e.g. "no @ (Mo-Fr 08:15-09:15,14:45-15:45; SH off)".
  const OSM_DAY = { Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 0 };
  function parseConditional(text) {
    const out = { rules: [], termOnly: false, ok: true };
    if (!text) return out;
    const parts = [...String(text).matchAll(/no\s*@\s*\(([^)]*)\)/gi)].map(m => m[1]);
    if (!parts.length) { out.ok = false; return out; }
    let lastDays = [0, 1, 2, 3, 4, 5, 6];
    for (const part of parts) for (let rule of part.split(';')) {
      rule = rule.trim();
      if (!rule) continue;
      if (/^SH\s+off$/i.test(rule)) { out.termOnly = true; continue; }
      if (/^PH\s+off$/i.test(rule)) continue;
      let days = null;
      const dm = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)/);
      if (dm) {
        days = [];
        for (const piece of dm[1].split(',')) {
          const [a, b] = piece.split('-').map(x => OSM_DAY[x.trim()]);
          if (b === undefined) days.push(a);
          else for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
        }
        rule = rule.slice(dm[0].length);
      }
      const ranges = [...rule.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)].map(m => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
      if (!ranges.length) { if (days) out.rules.push({ days, ranges: [[0, 1440]] }); else out.ok = false; continue; }
      out.rules.push({ days: days || lastDays, ranges });
      if (days) lastDays = days;
    }
    if (!out.rules.length) out.ok = false;
    return out;
  }

  function loadRestrictions(geojson, schoolFeats, roads) {
    const list = geojson.features.map(f => {
      const p = f.properties;
      const pts = f.geometry.coordinates.map(([lon, lat]) => toM(lon, lat));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
      return { ...p, pts, bbox: [x0, y0, x1, y1], cond: parseConditional(p.when) };
    });
    // Council School Street data wins: drop OSM timed restrictions that sit on a School Street.
    if (schoolFeats) for (const r of list) {
      if (r.kind !== 'TIMED NO ENTRY') continue;
      const mid = r.pts[Math.floor(r.pts.length / 2)];
      const hit = schoolFeats.find(f => nearest(f, mid).d < 60);
      if (hit) r.school = hit.id;
    }
    if (roads) for (const r of list) {
      if (r.road) continue;
      const n = nearestNamed(roads, r.pts[Math.floor(r.pts.length / 2)], 80);
      if (n) r.road = `Near ${n.name}`;
    }
    return list.filter(r => !r.school);
  }

  function restrStatus(r, clock) {
    if (!r.when) return { k: 'closed', allDay: true };
    if (!r.cond.ok) return { k: 'unknown' };
    if (r.cond.termOnly && !clock.term) return { k: 'open', why: 'SCHOOL HOLIDAYS' };
    const today = r.cond.rules.filter(x => x.days.includes(clock.day)).flatMap(x => x.ranges);
    for (const [a, b] of today) if (clock.min >= a && clock.min < b) return { k: 'closed', until: b, allDay: a === 0 && b === 1440 };
    const next = today.map(w => w[0]).filter(a => a > clock.min).sort((a, b) => a - b)[0];
    if (next !== undefined && next - clock.min <= 30) return { k: 'closing', at: next, inMin: next - clock.min };
    return { k: 'open', next };
  }

  // Nearest restricted way to point p that lines up with the heading (restrictions apply both ways).
  function matchRestriction(list, p, heading, maxD) {
    let best = null;
    for (const r of list) {
      const b = r.bbox;
      if (p[0] < b[0] - maxD || p[0] > b[2] + maxD || p[1] < b[1] - maxD || p[1] > b[3] + maxD) continue;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const q = segDist(p, r.pts[i], r.pts[i + 1]);
        if (q.d > maxD) continue;
        if (heading != null) { const ad = angleDiff(heading, bearing(r.pts[i], r.pts[i + 1])); if (Math.min(ad, 180 - ad) > 35) continue; }
        if (!best || q.d < best.d) best = { r, d: q.d };
      }
    }
    return best;
  }

  // ================= Cameras and yellow boxes =================
  function loadCameras(geojson) {
    return geojson.features.map(f => ({ ...f.properties, m: toM(f.geometry.coordinates[0], f.geometry.coordinates[1]) }));
  }
  function loadYellowBoxes(geojson) {
    return geojson.features.map(f => {
      const g = f.geometry;
      const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(poly => poly[0].map(([lon, lat]) => toM(lon, lat)));
      const all = rings.flat();
      const c = [all.reduce((s, q) => s + q[0], 0) / all.length, all.reduce((s, q) => s + q[1], 0) / all.length];
      const first = String(f.properties.junction || '').split('/')[0].replace(/\(.*?\)/g, '').trim();
      return { ...f.properties, rings, c, short: shortName(first.replace(/\bRD\b/g, 'Road').replace(/\bSTH\b/g, 'South').replace(/\bST\b/g, 'Street')) };
    });
  }
  function boxDist(bx, p) {
    if (bx.rings.some(r => inRing(p, r))) return 0;
    let d = Infinity;
    for (const r of bx.rings) for (let i = 0; i < r.length - 1; i++) d = Math.min(d, segDist(p, r[i], r[i + 1]).d);
    return d;
  }

  // Something in front of us: distance, and how far off our line of travel it is.
  function aheadOf(p, heading, q) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const ang = angleDiff(heading, bearing(p, q));
    return { d, ang, lateral: d * Math.sin(Math.min(ang, 90) * Math.PI / 180) };
  }

  // ================= the decision =================
  // pos = { x, y (metres), acc (m), speed (m/s or null), heading (deg or null) }
  // ctx = { roads, zones, parked, mem }  (all optional; mem is a {} the caller keeps between calls)
  const SEVERITY = { N: 0, K: 1, G: 1, F: 1, P: 1, O: 2, W: 3, Y: 3, C: 4, E: 4, S: 4, X: 5, R: 5 };

  function evaluate(feats, pos, clock, ctx = {}) {
    const mem = ctx.mem || (ctx.mem = {});
    const a = decide(feats, pos, clock, ctx, mem);
    // speed limit of the road we're on, and whether we're over it
    if (pos && pos.acc <= 100 && ctx.roads && a.st !== 'P' && a.st !== 'F') {
      const moving = pos.speed != null && pos.speed >= 2.5 && pos.heading != null;
      const here = matchRoad(ctx.roads, [pos.x, pos.y], moving ? pos.heading : null, Math.max(15, Math.min(pos.acc || 0, 25)));
      if (here && here.way.limit) { mem.limit = here.way.limit; mem.limitMiss = 0; }
      else if ((mem.limitMiss = (mem.limitMiss || 0) + 1) > 3) mem.limit = 0;  // keep the last limit briefly through gaps
      a.limit = mem.limit || null;
      a.mph = pos.speed != null ? Math.round(pos.speed * 2.23694) : null;
      a.over = a.limit && a.mph != null && moving ? (a.mph >= a.limit * 1.1 + 2 ? 2 : a.mph > a.limit ? 1 : 0) : 0;
    }
    return a;
  }

  function decide(feats, pos, clock, ctx, mem) {
    if (!pos) return mk('N', { word: 'READY', road: 'TAP START GPS', detail: '', instr: 'Mount the phone, then tap START GPS.' });
    if (pos.acc > 100) return mk('G', { word: 'NO GPS', road: '', detail: `GPS ±${Math.round(pos.acc)} M`, puckDetail: 'WAITING FOR SIGNAL', instr: 'Waiting for a better GPS signal.', acc: pos.acc });

    const acc = Math.min(pos.acc || 0, 50);
    const moving = pos.speed != null && pos.speed >= 2.5 && pos.heading != null;
    const speed = pos.speed != null ? pos.speed : 0;
    const warnR = Math.min(600, Math.max(250, 250 + speed * 20)) + acc;  // look-ahead geofence
    const inR = 35 + Math.min(pos.acc || 0, 40);                        // "you're at it" geofence
    const p = [pos.x, pos.y];
    const extra = { acc: pos.acc, warnR, inR };

    const c = feats.map(f => {
      const n = nearest(f, p);
      const ahead = moving ? angleDiff(pos.heading, bearing(p, n.pt)) <= 75 || n.d < inR : null;
      const etaMin = n.d / Math.max(speed, 3) / 60;  // cautious: slow London traffic arrives later
      const now = status(f, clock);
      const arrive = status(f, { ...clock, min: clock.min + etaMin });
      return { f, d: n.d, pt: n.pt, ahead, now, arrive, etaMin };
    }).sort((a, b) => a.d - b.d);

    // --- at a closed School Street ---
    const at = c.find(r => r.d <= inR && r.now.k === 'closed');
    if (at) return mk('X', {
      ...extra, f: at.f, dist: at.d, word: "DON'T ENTER",
      detail: `CLOSED UNTIL ${fmt(at.now.until)}`,
      instr: `You're at the ${at.f.road} closure. Don't drive in.`,
    });

    // --- one-way streets (needs a direction of travel) ---
    let wrong = null, noEntry = null;
    if (ctx.roads && moving) {
      const here = matchRoad(ctx.roads, p, pos.heading, Math.max(12, Math.min(pos.acc || 0, 20)));
      if (here && here.way.oneway && angleDiff(pos.heading, here.bearing) > 150) wrong = here;
      const h = pos.heading * Math.PI / 180;
      const look = Math.min(45, Math.max(25, speed * 4));
      const ahead = matchRoad(ctx.roads, [p[0] + Math.sin(h) * look, p[1] + Math.cos(h) * look], pos.heading, 12);
      if (ahead && ahead.way.oneway && angleDiff(pos.heading, ahead.bearing) > 150 &&
          (!here || (ahead.wi !== here.wi && ahead.way.name !== here.way.name))) noEntry = { ...ahead, look };
    }
    if (ctx.fixId === undefined || ctx.fixId !== mem.fixId) {  // two GPS readings in a row before we shout
      mem.fixId = ctx.fixId;
      mem.wrong = wrong ? (mem.wrong || 0) + 1 : 0;
      mem.noEntry = noEntry ? (mem.noEntry || 0) + 1 : 0;
    }
    if (wrong && mem.wrong >= 2) return mk('R', {
      ...extra, kind: 'ONE WAY STREET', word: 'WRONG WAY', road: (wrong.way.name || 'ONE-WAY STREET').toUpperCase(),
      roadShort: shortName(wrong.way.name || 'ONE-WAY STREET'), dist: 0,
      detail: 'STOP AND TURN AROUND SAFELY', puckDetail: 'TURN AROUND SAFELY',
      instr: "You're driving against a one-way street.",
    });

    // --- restricted street: already on it while it's in force ---
    let rAt = null, rAhead = null;
    if (ctx.restr && moving) {
      const onIt = matchRestriction(ctx.restr, p, pos.heading, 10 + Math.min(pos.acc || 0, 15));
      if (onIt && restrStatus(onIt.r, clock).k === 'closed') rAt = onIt;
      const h = pos.heading * Math.PI / 180;
      for (const look of [30, 55, 80]) {
        const hit = matchRestriction(ctx.restr, [p[0] + Math.sin(h) * look, p[1] + Math.cos(h) * look], pos.heading, 12);
        if (hit && (!onIt || hit.r.id !== onIt.r.id)) { rAhead = { ...hit, dist: look }; break; }
        if (hit && onIt && hit.r.id === onIt.r.id && restrStatus(hit.r, clock).k !== 'closed') { rAhead = { ...hit, dist: 0 }; break; }
      }
    }
    if (ctx.fixId === undefined || ctx.fixId !== mem.fixId2) {
      mem.fixId2 = ctx.fixId;
      mem.rAt = rAt ? (mem.rAt || 0) + 1 : 0;
    }
    if (rAt && mem.rAt >= 2) {
      const r = rAt.r, st = restrStatus(r, clock);
      return mk('X', {
        ...extra, kind: r.kind, word: "DON'T ENTER", road: (r.road || r.kind).toUpperCase(), roadShort: shortName(r.road || r.kind), dist: 0,
        detail: st.allDay ? (r.verified ? 'AT ALL TIMES' : 'CHECK THE SIGNS') : `UNTIL ${fmt(st.until)}`,
        instr: `You're on a restricted street (${r.kind.toLowerCase()}). Leave at the next safe turning.${r.verified ? '' : ' Not yet verified: check the signs.'}`, restr: r,
      });
    }

    // --- safety camera ahead ---
    if (ctx.cams && moving) {
      const camR = Math.min(400, Math.max(250, speed * 20)) + acc;
      let cam = null;
      for (const q of ctx.cams) {
        const a = aheadOf(p, pos.heading, q.m);
        if (a.d > camR || a.d < 15 || a.ang > 45 || a.lateral > 25 + acc) continue;
        if (!cam || a.d < cam.d) cam = { q, d: a.d };
      }
      if (cam) {
        const red = cam.q.type === 'red light', lim = cam.q.maxspeed || mem.limit || null;
        const mph = Math.round(speed * 2.23694), over = lim && mph > lim;
        return mk('S', {
          ...extra, kind: red ? 'RED LIGHT CAMERA' : 'SPEED CAMERA', word: 'CAMERA',
          road: lim ? `${lim} MPH LIMIT` : 'SPEED CAMERA', roadShort: lim ? `${lim} MPH LIMIT` : 'CHECK SPEED', dist: cam.d,
          detail: red ? 'STOP ON RED' : over ? `SLOW DOWN - YOU'RE AT ${mph}` : 'CHECK YOUR SPEED',
          puckDetail: red ? 'STOP ON RED' : over ? 'SLOW DOWN' : 'CHECK YOUR SPEED',
          instr: red ? 'Red light camera ahead.' : `Speed camera ahead${lim ? `, ${lim} mph limit` : ''}.`, cam: cam.q, camOver: !!over,
        });
      }
    }

    // --- School Street ahead ---
    const near = c.filter(r => r.d <= warnR && r.ahead !== false);
    const closed = near.find(r => r.now.k === 'closed' || r.arrive.k === 'closed');
    if (closed) {
      const nowClosed = closed.now.k === 'closed';
      const until = nowClosed ? closed.now.until : closed.arrive.until;
      return mk('C', {
        ...extra, f: closed.f, dist: closed.d, word: 'CLOSED',
        detail: nowClosed ? `UNTIL ${fmt(until)}` : `CLOSES ${fmt(closed.now.at ?? clock.min)} BEFORE YOU ARRIVE`,
        puckDetail: nowClosed ? `UNTIL ${fmt(until)}` : `CLOSES AT ${fmt(closed.now.at ?? clock.min)}`,
        instr: `Don't turn into ${closed.f.road}.`,
      });
    }
    // --- bus lanes on this road, in this direction ---
    let busWarn = null, busAlong = null;
    if (ctx.bus && moving) {
      const maxD = 15 + Math.min(pos.acc || 0, 15);
      const h = pos.heading * Math.PI / 180;
      const on = matchBusLane(ctx.bus, p, pos.heading, maxD);
      const soon = on ? null : matchBusLane(ctx.bus, [p[0] + Math.sin(h) * 60, p[1] + Math.cos(h) * 60], pos.heading, maxD);
      const hit = on || soon;
      if (hit) {
        const l = hit.l, st = busStatus(l, clock), road = l.road.toUpperCase(), rs = shortName(l.road);
        const who = l.vehicles.replace(/ and /i, ', ').toUpperCase();
        const dist = on ? null : 60;
        if (st.k === 'closed') {
          const busC = mk('C', {
            ...extra, kind: 'BUS LANE', word: 'CLOSED', road, roadShort: rs, dist,
            detail: st.allDay ? 'IN FORCE 24 HOURS' : `IN FORCE UNTIL ${fmt(st.until)}`,
            puckDetail: st.allDay ? 'KEEP OUT - 24 HOURS' : `KEEP OUT TIL ${fmt(st.until)}`,
            instr: `Stay out of the bus lane. ${who} only.`, lane: l,
          });
          if (!on) return busC;       // a bus lane starting just ahead
          busAlong = busC;            // already beside it: hazards just ahead come first
        }
        if (st.k === 'closing') busWarn = mk('W', {
          ...extra, kind: 'BUS LANE', word: 'CLOSING', road, roadShort: rs, dist,
          detail: `IN FORCE FROM ${fmt(st.at)}`, puckDetail: `FROM ${fmt(st.at)}`,
          instr: `The bus lane comes into force in ${st.inMin} min. Leave it before ${fmt(st.at)}.`, lane: l,
        });
        mem.busOpen = st.k === 'open' ? { l, st, road, rs, dist } : null;  // open lanes are shown only if nothing else is going on
      } else mem.busOpen = null;
    } else mem.busOpen = null;

    // --- bus gate / no motor vehicles / pedestrian zone / timed no entry ahead ---
    let restrWarn = null;
    mem.restrOpen = null;
    if (rAhead) {
      const r = rAhead.r, st = restrStatus(r, clock);
      const road = (r.road || r.kind).toUpperCase(), rs = shortName(r.road || r.kind);
      const check = r.verified ? '' : ' Not yet verified: check the signs.';
      if (st.k === 'closed' || st.k === 'unknown') return mk('E', {
        ...extra, kind: r.kind, word: 'NO ENTRY', road, roadShort: rs, dist: rAhead.dist,
        detail: st.k === 'unknown' ? 'TIMES UNKNOWN - CHECK THE SIGNS' : st.allDay ? (r.kind === 'BUS GATE' ? 'BUSES, CYCLES AND TAXIS ONLY' : 'NO CARS') : `UNTIL ${fmt(st.until)}`,
        puckDetail: st.k === 'unknown' ? 'CHECK THE SIGNS' : st.allDay ? (r.verified ? 'AT ALL TIMES' : 'CHECK THE SIGNS') : `UNTIL ${fmt(st.until)}`,
        instr: `Don't drive into ${r.road || 'this street'} (${r.kind.toLowerCase()}).${check}`, restr: r,
      });
      if (st.k === 'closing') restrWarn = mk('W', {
        ...extra, kind: r.kind, word: 'CLOSING', road, roadShort: rs, dist: rAhead.dist,
        detail: `NO ENTRY FROM ${fmt(st.at)}`, puckDetail: `NO ENTRY FROM ${fmt(st.at)}`,
        instr: `${r.road || 'This street'} closes to cars at ${fmt(st.at)}.${check}`, restr: r,
      });
      else mem.restrOpen = { r, st, road, rs, dist: rAhead.dist };
    }

    if (noEntry && mem.noEntry >= 2) return mk('E', {
      ...extra, kind: 'ONE WAY STREET', word: 'NO ENTRY', road: (noEntry.way.name || 'ONE-WAY STREET').toUpperCase(),
      roadShort: shortName(noEntry.way.name || 'ONE-WAY STREET'), dist: noEntry.look,
      detail: 'ONE-WAY AGAINST YOU', puckDetail: 'ONE WAY AGAINST YOU',
      instr: `Don't go straight on into ${noEntry.way.name || 'the one-way street'}.`,
    });

    // --- yellow box junction ahead ---
    if (ctx.boxes && moving) {
      let box = null;
      for (const bx of ctx.boxes) {
        const a = aheadOf(p, pos.heading, bx.c);
        if (a.d > 90 + acc || a.ang > 50) continue;
        const d = boxDist(bx, p);
        if (d > 70 + acc || (a.lateral > 20 + acc && d > 0)) continue;
        if (!box || d < box.d) box = { bx, d };
      }
      if (box) return mk('Y', {
        ...extra, kind: 'YELLOW BOX JUNCTION', word: 'KEEP CLEAR', road: box.bx.junction.replace(/\s*\(.*?\)\s*/g, ' ').trim(), roadShort: box.bx.short, dist: box.d || null,
        detail: box.d ? 'ENTER ONLY IF YOUR EXIT IS CLEAR' : "DON'T STOP IN THE BOX",
        puckDetail: box.d ? 'EXIT MUST BE CLEAR' : "DON'T STOP IN BOX",
        instr: 'Yellow box: only enter when your exit is clear (you may wait in it to turn right).', box: box.bx,
      });
    }

    if (busAlong) return busAlong;
    const closing = near.find(r => r.now.k === 'closing');
    if (closing) return mk('W', {
      ...extra, f: closing.f, dist: closing.d, word: 'CLOSING',
      detail: `CLOSES IN ${closing.now.inMin} MIN`,
      instr: `Avoid ${closing.f.road} from ${fmt(closing.now.at)}.`,
    });
    if (busWarn) return busWarn;
    if (restrWarn) return restrWarn;

    // --- parked: what are the parking rules here? ---
    if (ctx.parked && (ctx.zones || ctx.pbp || ctx.cps)) {
      const apps = ctx.apps || ctx.payApp;
      const pk = ctx.zones ? parkingAt(ctx.zones, p, clock) : { k: 'none' };
      const here = ctx.pbp ? nearestPayByPhone(ctx.pbp, p, 45 + acc) : null;          // pay bay on this street
      const nearby = here || (ctx.pbp ? nearestPayByPhone(ctx.pbp, p, 250) : null);   // nearest one at all
      const ps = here ? payStatus(here, clock) : null;
      // car parks: one you may be standing in, and one worth suggesting when the street is permit-only
      const cpIn = ctx.cps ? nearestPayByPhone(ctx.cps, p, 30 + Math.min(acc, 40)) : null;
      const cpNear = cpIn || (ctx.cps ? nearestPayByPhone(ctx.cps, p, 60 + acc) : null);
      const cpAlt = cpNear || (ctx.cps ? nearestPayByPhone(ctx.cps, p, 800) : null);
      const zoneLine = pk.z ? `ZONE ${pk.z.code} ${pk.z.zone}`.toUpperCase() : '';
      const edge = pk.z && pk.edge < 40 + acc ? ' Near a zone boundary: check the signs.' : '';
      const appOf = pt => appFor(apps, pt.app);
      const codeLine = pt => `${appOf(pt).name} ${pt.code}`.toUpperCase();
      const payInfo = pt => `${appOf(pt).name} location ${pt.code} (${pt.street}${pt.d > 45 ? `, ${Math.round(pt.d)} m away` : ''}${pt.max_stay_h ? `, max ${pt.max_stay_h} h` : ''}${priceText(pt.tariff) ? `, ${priceText(pt.tariff).toLowerCase()} in council data` : ''})`;
      const cpInfo = cp => `${cp.name} (${appOf(cp).name} ${cp.code}${cp.d > 30 ? `, ${Math.round(cp.d / 10) * 10} m away` : ''})`;
      const pay = pt => pt ? { app: appOf(pt), code: pt.code, street: pt.street } : null;
      const carPay = cp => cp ? { app: appOf(cp), code: cp.code, street: cp.name, carPark: cp } : null;
      if (here && ps.k === 'pay') return mk('P', {
        ...extra, kind: 'PARKING', word: 'PAY', road: codeLine(here), roadShort: codeLine(here),
        detail: `PAY UNTIL ${fmt(ps.until)}${here.max_stay_h ? ` - MAX ${here.max_stay_h} H` : ''}${priceText(here.tariff) ? ` - ${priceText(here.tariff)}` : ''}`,
        puckDetail: `${here.max_stay_h ? `MAX ${here.max_stay_h} H - ` : ''}TIL ${fmt(ps.until)}`,
        instr: `Pay to park: ${payInfo(here)}. Resident permit holders can use permit bays.${cpNear ? ` In the car park instead? ${cpInfo(cpNear)}.` : ''}${edge}`,
        park: pk, pbp: here, pay: pay(here), alt: carPay(cpNear),
      });
      if (pk.k === 'controlled') return mk('P', {
        ...extra, kind: 'PARKING', word: pk.residents ? 'RESIDENTS' : 'PERMIT', road: zoneLine, roadShort: zoneLine,
        detail: `${pk.residents ? 'RESIDENTS ONLY' : 'PERMIT HOLDERS'} ${whenText(pk)}`,
        puckDetail: `${pk.residents ? 'RESIDENTS' : 'PERMIT'} TIL ${fmt(pk.until)}`,
        instr: `Controlled hours: permit bays need a permit, single yellow lines mean no waiting.${nearby ? ` Nearest pay bay: ${payInfo(nearby)}.` : ''}${cpAlt ? ` Nearest car park: ${cpInfo(cpAlt)}.` : ''}${edge}`,
        park: pk, pbp: nearby, pay: pay(nearby), alt: carPay(cpAlt),
      });
      if (pk.k === 'free' || (here && ps.k === 'free')) {
        const until = here && ps.k === 'free' && ps.from ? (ps.from.today ? `UNTIL ${fmt(ps.from.min)}` : `UNTIL ${DAYS[ps.from.day]} ${fmt(ps.from.min)}`) : whenText(pk);
        return mk('F', {
          ...extra, kind: 'PARKING', word: 'FREE', road: zoneLine || codeLine(here), roadShort: zoneLine || codeLine(here),
          detail: `FREE ${until}`, puckDetail: until,
          instr: `Bays and single yellow lines are free now. Double yellows, red routes and bay signs still apply.${here ? ` Pay from then with ${payInfo(here)}.` : ''}${cpNear ? ` Car parks charge their own hours: ${cpInfo(cpNear)}.` : ''}${edge}`,
          park: pk, pbp: here || nearby, pay: pay(here || nearby), alt: carPay(cpNear),
        });
      }
      // no street rule known here, but you're at an app-paid car park
      if (cpIn) {
        const ms = cpIn.max_stay ? `MAX ${cpIn.max_stay.toUpperCase()}` : '';
        return mk('P', {
          ...extra, kind: 'CAR PARK', word: 'PAY', road: codeLine(cpIn), roadShort: codeLine(cpIn),
          detail: [`PAY WITH ${appOf(cpIn).name.toUpperCase()}`, ms].filter(Boolean).join(' - '),
          puckDetail: ms || `PAY WITH ${appOf(cpIn).name.toUpperCase()}`,
          instr: `In the car park? ${cpInfo(cpIn)}.${cpIn.price ? ` ${cpIn.price}.` : ''}${cpIn.note ? ` ${cpIn.note}` : ''} On the street outside, check the signs.`,
          park: pk, pay: carPay(cpIn),
        });
      }
    }

    const open = c.find(r => r.d <= warnR && r.now.k === 'open' && r.ahead !== false);
    if (open) {
      const st = open.now;
      const detail = st.allDay ? `OPEN ALL DAY · ${st.why}` : st.next !== undefined ? `NEXT CLOSURE ${fmt(st.next)}` : 'NO MORE CLOSURES TODAY';
      return mk('O', {
        ...extra, f: open.f, dist: open.d, word: 'OPEN', detail,
        puckDetail: st.allDay ? st.why : st.next !== undefined ? `NEXT CLOSURE ${fmt(st.next)}` : 'OPEN REST OF DAY',
        instr: `${open.f.road} is open to traffic.`,
      });
    }
    if (mem.busOpen) {
      const { l, st, road, rs, dist } = mem.busOpen;
      return mk('O', {
        ...extra, kind: 'BUS LANE', word: 'OPEN', road, roadShort: rs, dist,
        detail: st.next !== undefined ? `NOT IN FORCE UNTIL ${fmt(st.next)}` : 'NOT IN FORCE TODAY',
        puckDetail: st.next !== undefined ? `USE IT TIL ${fmt(st.next)}` : 'OPEN REST OF DAY',
        instr: 'The bus lane is not in force: you can drive in it.', lane: l,
      });
    }
    if (mem.restrOpen) {
      const { r, st, road, rs, dist } = mem.restrOpen;
      return mk('O', {
        ...extra, kind: r.kind, word: 'OPEN', road, roadShort: rs, dist,
        detail: st.why ? `OPEN ALL DAY - ${st.why}` : st.next !== undefined ? `NO ENTRY FROM ${fmt(st.next)}` : 'OPEN REST OF DAY',
        puckDetail: st.why || (st.next !== undefined ? `CLOSES ${fmt(st.next)}` : 'OPEN REST OF DAY'),
        instr: `${r.road || 'This street'} is open to cars now.${r.verified ? '' : ' Not yet verified: check the signs.'}`, restr: r,
      });
    }
    const first = c[0];
    const passed = first && first.ahead === false && first.d <= warnR;
    return mk('K', {
      ...extra, word: 'CLEAR', road: 'NO CLOSURES AHEAD', dist: null,
      detail: passed ? `${first.f.road_short} IS BEHIND YOU` : first ? `NEAREST ${fmtDist(first.d)}` : '',
      puckDetail: passed ? `PASSED ${first.f.road_short}` : first ? `NEAREST ${fmtDist(first.d)}` : '',
      instr: '',
    });
  }

  const ABBR = { Road: 'RD', Street: 'ST', Lane: 'LN', Gardens: 'GDNS', Grove: 'GR', Close: 'CL', Avenue: 'AVE', Court: 'CT', Place: 'PL', Crescent: 'CRES', Square: 'SQ', Terrace: 'TER' };
  function shortName(n) { return String(n).split(' ').map(w => ABBR[w] || w).join(' ').toUpperCase(); }

  function mk(st, o) {
    const f = o.f;
    return {
      st, severity: SEVERITY[st],
      kind: o.kind || (f ? f.kind : 'ROAD PUCK'),
      word: o.word,
      road: o.road != null ? o.road : (f ? f.road.toUpperCase() : ''),
      roadShort: o.roadShort != null ? o.roadShort : o.road != null ? o.road : (f ? f.road_short : ''),
      dist: o.dist != null ? o.dist : null,
      detail: o.detail || '',
      puckDetail: o.puckDetail || o.detail || '',
      instr: o.instr || '',
      acc: o.acc != null ? o.acc : null,
      warnR: o.warnR, inR: o.inR,
      f: f || null,
      park: o.park || null,
      pbp: o.pbp || null,
      pay: o.pay || null,
      alt: o.alt || null,
      lane: o.lane || null,
      restr: o.restr || null, cam: o.cam || null, box: o.box || null, camOver: !!o.camOver,
      limit: null, mph: null, over: 0,
      key: st + (o.kind || '') + (f ? f.id : o.lane ? o.lane.id : o.restr ? o.restr.id : o.cam ? o.cam.id : o.box ? o.box.id : o.road || ''),
    };
  }

  function fmtDist(m) {
    if (m == null) return '';
    if (m < 1000) return `${m < 10 ? 10 : Math.round(m / 10) * 10} M`;
    return `${(m / 1000).toFixed(1)} KM`;
  }

  // ---- steadiness: don't let the alert flicker between states ----
  function makeTracker(holdMs = 4000) {
    let last = null, lastAt = 0;
    return function (next, nowMs) {
      if (!last || next.severity >= last.severity || nowMs - lastAt > holdMs ||
          (last.f && next.f && last.f.id !== next.f.id && next.severity > 1)) {
        if (!last || next.key !== last.key) lastAt = nowMs;
        last = next;
        return next;
      }
      return last;  // keep the stronger warning a few seconds longer
    };
  }

  // ---- message for the puck ----
  function clean(s) { return String(s || '').toUpperCase().replace(/[|]/g, '/').replace(/[^\x20-\x5A]/g, ' ').replace(/\s+/g, ' ').trim(); }
  // v2: 2|STATE|ROAD|DIST|DETAIL|ACC|KIND|WORD|LIMIT|OVER
  function puckMessage(a) {
    const st = a.st === 'N' ? 'G' : a.st;
    const dist = a.dist != null && 'CWOXESY'.includes(a.st) ? Math.round(a.dist) : '';
    const detail = a.st === 'N' ? 'START GPS ON PHONE' : a.puckDetail;
    const acc = a.acc != null ? Math.round(a.acc) : '';
    const word = a.st === 'N' ? 'NO GPS' : a.word;
    const over = a.st === 'S' && a.camOver ? Math.max(a.over || 0, 1) : (a.over || 0);
    return ['2', st, clean(a.st === 'N' ? '' : a.roadShort), dist, clean(detail), acc, clean(a.kind), clean(word), a.limit || '', over].join('|');
  }

  const api = {
    LON0, LAT0, toM, toLL, loadFeatures, nearest, londonNow, inTerm, status, evaluate, makeTracker, puckMessage,
    fmt, fmtDist, bearing, angleDiff, parseTimings, loadZones, inZone, zoneStatus, parkingAt, whenText, loadRoads, matchRoad, shortName, DAYS,
    parseHours, loadBusLanes, busStatus, matchBusLane, loadPayByPhone, nearestPayByPhone, parsePayHours, payStatus, priceText, loadCarParks, appFor,
    parseConditional, loadRestrictions, nearestNamed, restrStatus, matchRestriction, loadCameras, loadYellowBoxes, boxDist, aheadOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoadEngine = api;

  function bearing(from, to) { return (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180 / Math.PI + 360) % 360; }
  function angleDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
})(typeof window !== 'undefined' ? window : globalThis);
