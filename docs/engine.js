/* Road Puck alert engine.
   Pure logic, no page code: positions in, one alert out.
   Used by the phone app (docs/index.html) and by tools/test_engine.js.

   Layers it understands:
     School Streets  timed closures (lines)           -> X, C, W, O
     One-way streets from the street map (lines)      -> R (wrong way), E (no entry ahead)
     Bus lanes       TfL lines with hours + direction -> C (in force), W (starts soon), O (not in force), kind BUS LANE
     Parking zones   CPZ polygons with hours          -> P (permit or pay now), F (free now)  -- only when parked */
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
    base.ways.forEach((w, wi) => {
      const pts = [];
      let x = 0, y = 0;
      for (let i = 3; i < w.length; i += 2) { x += w[i]; y += w[i + 1]; pts.push([x, y]); }
      ways.push({ cls: w[0], name: base.names[w[1]] || '', oneway: w[2] === 1, pts });
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
  function loadPayByPhone(geojson) {
    return geojson.features.map(f => ({ ...f.properties, m: toM(f.geometry.coordinates[0], f.geometry.coordinates[1]) }));
  }
  function nearestPayByPhone(points, p, maxD = 150) {
    let best = null;
    for (const pt of points) {
      const d = Math.hypot(pt.m[0] - p[0], pt.m[1] - p[1]);
      if (d <= maxD && (!best || d < best.d)) best = { ...pt, d };
    }
    return best;
  }

  // ================= the decision =================
  // pos = { x, y (metres), acc (m), speed (m/s or null), heading (deg or null) }
  // ctx = { roads, zones, parked, mem }  (all optional; mem is a {} the caller keeps between calls)
  const SEVERITY = { N: 0, K: 1, G: 1, F: 1, P: 1, O: 2, W: 3, C: 4, E: 4, X: 5, R: 5 };

  function evaluate(feats, pos, clock, ctx = {}) {
    const mem = ctx.mem || {};
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
    if (noEntry && mem.noEntry >= 2) return mk('E', {
      ...extra, kind: 'ONE WAY STREET', word: 'NO ENTRY', road: (noEntry.way.name || 'ONE-WAY STREET').toUpperCase(),
      roadShort: shortName(noEntry.way.name || 'ONE-WAY STREET'), dist: noEntry.look,
      detail: 'ONE-WAY AGAINST YOU', puckDetail: 'ONE WAY AGAINST YOU',
      instr: `Don't go straight on into ${noEntry.way.name || 'the one-way street'}.`,
    });
    const closing = near.find(r => r.now.k === 'closing');
    if (closing) return mk('W', {
      ...extra, f: closing.f, dist: closing.d, word: 'CLOSING',
      detail: `CLOSES IN ${closing.now.inMin} MIN`,
      instr: `Avoid ${closing.f.road} from ${fmt(closing.now.at)}.`,
    });

    // --- bus lanes on this road, in this direction ---
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
        if (st.k === 'closed') return mk('C', {
          ...extra, kind: 'BUS LANE', word: 'CLOSED', road, roadShort: rs, dist,
          detail: st.allDay ? 'IN FORCE 24 HOURS' : `IN FORCE UNTIL ${fmt(st.until)}`,
          puckDetail: st.allDay ? 'KEEP OUT - 24 HOURS' : `KEEP OUT TIL ${fmt(st.until)}`,
          instr: `Stay out of the bus lane. ${who} only.`, lane: l,
        });
        if (st.k === 'closing') return mk('W', {
          ...extra, kind: 'BUS LANE', word: 'CLOSING', road, roadShort: rs, dist,
          detail: `IN FORCE FROM ${fmt(st.at)}`, puckDetail: `FROM ${fmt(st.at)}`,
          instr: `The bus lane comes into force in ${st.inMin} min. Leave it before ${fmt(st.at)}.`, lane: l,
        });
        mem.busOpen = { l, st, road, rs, dist };  // open lanes are shown only if nothing else is going on
      } else mem.busOpen = null;
    } else mem.busOpen = null;

    // --- parked: what are the parking rules here? ---
    if (ctx.parked && ctx.zones) {
      const pk = parkingAt(ctx.zones, p, clock);
      const pbp = ctx.pbp ? nearestPayByPhone(ctx.pbp, p) : null;
      const payLine = pbp ? ` Pay-by-phone location ${pbp.code} (${pbp.street}, max ${pbp.max_stay_h} h).` : '';
      if (pk.k === 'controlled' || pk.k === 'free') {
        const z = pk.z, zoneLine = `ZONE ${z.code} ${z.zone}`.toUpperCase();
        const edge = pk.edge < 40 + acc ? ' Near a zone boundary: check the signs.' : '';
        if (pk.k === 'controlled') return mk('P', {
          ...extra, kind: 'PARKING', word: pk.residents ? 'RESIDENTS' : 'PERMIT', road: zoneLine, roadShort: zoneLine,
          detail: `${pk.residents ? 'RESIDENTS ONLY' : 'PERMIT OR PAY'} ${whenText(pk)}`,
          puckDetail: `${pk.residents ? 'RESIDENTS' : 'OR PAY'} TIL ${fmt(pk.until)}`,
          instr: `Controlled hours now. Single yellow lines: no waiting. Bays: permit or pay-by-phone.${payLine}${edge}`, park: pk, pbp,
        });
        return mk('F', {
          ...extra, kind: 'PARKING', word: 'FREE', road: zoneLine, roadShort: zoneLine,
          detail: `FREE ${whenText(pk)}`,
          puckDetail: whenText(pk),
          instr: `Bays and single yellow lines are free now. Double yellows, red routes and bay signs still apply.${edge}`, park: pk, pbp,
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
      lane: o.lane || null,
      key: st + (o.kind || '') + (f ? f.id : o.lane ? o.lane.id : o.road || ''),
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
  function puckMessage(a) {
    const st = a.st === 'N' ? 'G' : a.st;
    const dist = a.dist != null && 'CWOXE'.includes(a.st) ? Math.round(a.dist) : '';
    const detail = a.st === 'N' ? 'START GPS ON PHONE' : a.puckDetail;
    const acc = a.acc != null ? Math.round(a.acc) : '';
    return ['1', st, clean(a.st === 'N' ? '' : a.roadShort), dist, clean(detail), acc, clean(a.kind)].join('|');
  }

  const api = {
    LON0, LAT0, toM, toLL, loadFeatures, nearest, londonNow, inTerm, status, evaluate, makeTracker, puckMessage,
    fmt, fmtDist, bearing, angleDiff, parseTimings, loadZones, inZone, zoneStatus, parkingAt, whenText, loadRoads, matchRoad, shortName, DAYS,
    parseHours, loadBusLanes, busStatus, matchBusLane, loadPayByPhone, nearestPayByPhone,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoadEngine = api;

  function bearing(from, to) { return (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180 / Math.PI + 360) % 360; }
  function angleDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
})(typeof window !== 'undefined' ? window : globalThis);
