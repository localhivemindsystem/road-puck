// Checks the alert engine against real Lambeth positions.  Run:  node tools/test_engine.js
const fs = require('fs');
const path = require('path');
const E = require('../docs/engine.js');

const gj = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/school_streets.geojson'), 'utf8'));
const feats = E.loadFeatures(gj);
const byRoad = r => feats.find(f => f.road === r);
const hack = byRoad('Hackford Road');           // Reay Primary, 08:30-09:30 / 14:45-15:45
const stud = byRoad('Studley Road');            // Allen Edwards, 08:15-09:15

const MON = (hhmm, term = true) => ({ day: 1, min: E.fmt ? toMin(hhmm) : 0, term });
const SAT = hhmm => ({ day: 6, min: toMin(hhmm), term: true });
function toMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
const at = (f, dx = 0, dy = 0, extra = {}) => ({ x: f.anchorM[0] + dx, y: f.anchorM[1] + dy, acc: 8, speed: null, heading: null, ...extra });

const cases = [
  ['At the Hackford Rd closure, Mon 08:40', at(hack), MON('08:40'), 'X'],
  ['200 m south, driving north towards it, Mon 08:40', at(hack, 0, -200, { speed: 9, heading: 0 }), MON('08:40'), 'C'],
  ['200 m south, driving south away from it, Mon 08:40', at(hack, 0, -200, { speed: 9, heading: 180 }), MON('08:40'), 'K'],
  ['Parked 120 m away, no heading, Mon 08:40', at(hack, 120, 0), MON('08:40'), 'C'],
  ['At Hackford Rd on Saturday', at(hack), SAT('08:40'), 'O'],
  ['At Hackford Rd in half-term', at(hack), MON('08:40', false), 'O'],
  ['At Hackford Rd, Mon 12:00 (between closures)', at(hack), MON('12:00'), 'O'],
  ['Near Studley Rd at 08:05 (closes 08:15)', at(stud, 0, -150), MON('08:05'), 'W'],
  ['Near Studley Rd at 08:14, 230 m out crawling at 3 m/s (closed on arrival)', at(stud, 0, -300, { speed: 3, heading: 0 }), MON('08:14'), 'C'],
  ['Brockwell Park, away from any closure', { x: E.toM(-0.1065, 51.4505)[0], y: E.toM(-0.1065, 51.4505)[1], acc: 8 }, MON('08:40'), 'K'],
  ['Weak GPS (150 m)', at(hack, 0, 0, { acc: 150 }), MON('08:40'), 'G'],
  ['No position yet', null, MON('08:40'), 'N'],
];

let fails = 0;
for (const [name, pos, clock, want] of cases) {
  const a = E.evaluate(feats, pos, clock);
  const ok = a.st === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      -> ${a.st} ${a.word} | ${a.road} | ${a.dist != null ? Math.round(a.dist) + ' m' : ''} | ${a.detail}\n      puck: ${E.puckMessage(a)}`);
}

// term dates
const terms = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/term_dates.json'), 'utf8')).terms;
const termChecks = [['2026-09-28', true], ['2026-10-27', false], ['2026-12-18', true], ['2026-12-24', false], ['2027-07-23', false]];
for (const [d, want] of termChecks) {
  const ok = E.inTerm(d, terms) === want; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${d} in term: ${E.inTerm(d, terms)}`);
}

// London clock across the October clock change
const lc = E.londonNow(new Date('2026-10-26T08:30:00Z'));
const okClock = lc.min === 8 * 60 + 30 && lc.day === 1; if (!okClock) fails++;
console.log(`${okClock ? 'PASS' : 'FAIL'}  London time after clocks go back: ${lc.date} day ${lc.day} ${E.fmt(lc.min)}`);

// ---------- parking zones ----------
console.log('\nParking zones');
const zones = E.loadZones(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/parking_zones.geojson'), 'utf8')));
const zoneBy = name => zones.find(z => z.name === name);
// a point well inside the zone (a zone's centre can fall in one of its holes)
const centre = z => {
  const [x0, y0, x1, y1] = z.bbox;
  for (let i = 1; i < 60; i++) for (let j = 1; j < 60; j++) {
    const p = [x0 + (x1 - x0) * i / 60, y0 + (y1 - y0) * j / 60];
    const hit = E.parkingAt(zones, p, { day: 1, min: 600 });
    if (hit.z === z && hit.edge > 60) return { x: p[0], y: p[1], acc: 8, speed: 0, heading: null };
  }
  throw new Error('no inside point for ' + z.name);
};
const parked = { zones, parked: true };
const pk = (label, pos, clock, wantSt, wantText) => {
  const a = E.evaluate([], pos, clock, parked);
  const ok = a.st === wantSt && (!wantText || (a.detail + ' ' + a.road).includes(wantText));
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      -> ${a.st} ${a.word} | ${a.road} | ${a.detail}\n      puck: ${E.puckMessage(a)}`);
};
const S_ = zoneBy("Stockwell 'S'"), BB = zones.find(z => z.timings === 'Mon-Sat 0830-1730 or 2030'), CR = zones.find(z => z.timings.includes('Residents Only') && z.area > 200000), W_ = zoneBy("Waterloo 'W'");
pk('Stockwell, Mon 10:00', centre(S_), { day: 1, min: 600, term: true }, 'P', 'UNTIL 17:30');
pk('Stockwell, Mon 19:00', centre(S_), { day: 1, min: 1140, term: true }, 'F', 'UNTIL TUE 08:30');
pk('Stockwell, Mon 07:00', centre(S_), { day: 1, min: 420, term: true }, 'F', 'UNTIL 08:30');
pk('Stockwell, Saturday', centre(S_), { day: 6, min: 600, term: true }, 'F', 'UNTIL MON 08:30');
pk('Brixton B late streets, Sat 19:00', centre(BB), { day: 6, min: 1140, term: true }, 'P', 'SOME STREETS UNTIL 20:30');
pk('Clapham C, Mon 10:00 (then residents only)', centre(CR), { day: 1, min: 600, term: true }, 'P', 'RESIDENTS ONLY TO 20:30');
pk('Clapham C, Mon 19:30 (residents only)', centre(CR), { day: 1, min: 1170, term: true }, 'P', 'RESIDENTS ONLY');
pk('Waterloo, Sat 12:00', centre(W_), { day: 6, min: 720, term: true }, 'P', 'UNTIL 13:30');
pk('Outside every zone (Brockwell Park)', { x: E.toM(-0.1065, 51.4505)[0], y: E.toM(-0.1065, 51.4505)[1], acc: 8, speed: 0 }, { day: 1, min: 600, term: true }, 'K');
{ const a = E.evaluate([], centre(S_), { day: 1, min: 600, term: true }, { zones }); const ok = a.st === 'K'; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Driving through Stockwell (not parked) shows no parking screen -> ${a.st}`); }

// ---------- one-way streets ----------
console.log('\nOne-way streets');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/basemap.json'), 'utf8'));
const roads = E.loadRoads(base);
const oneways = roads.ways.filter(w => w.oneway && w.name && w.cls >= 3);
console.log(`      ${oneways.length} named one-way streets in the street map`);
// pick a straight one-way stretch at least 80 m long
let pick = null;
for (const w of oneways) {
  for (let i = 0; i < w.pts.length - 1 && !pick; i++) {
    const a = w.pts[i], b = w.pts[i + 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 80) pick = { w, a, b };
  }
  if (pick) break;
}
const flow = E.bearing(pick.a, pick.b), mid = [(pick.a[0] + pick.b[0]) / 2, (pick.a[1] + pick.b[1]) / 2];
const drive = heading => { const mem = {}; let a; for (let k = 0; k < 2; k++) a = E.evaluate([], { x: mid[0], y: mid[1], acc: 6, speed: 7, heading }, MON('12:00'), { roads, mem }); return a; };
{
  const against = drive((flow + 180) % 360), withFlow = drive(flow);
  const ok1 = against.st === 'R', ok2 = withFlow.st !== 'R';
  if (!ok1) fails++; if (!ok2) fails++;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  Against the flow on ${pick.w.name} -> ${against.st} ${against.word} | ${against.road}`);
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  With the flow on ${pick.w.name} -> ${withFlow.st} ${withFlow.word}`);
  const once = E.evaluate([], { x: mid[0], y: mid[1], acc: 6, speed: 7, heading: (flow + 180) % 360 }, MON('12:00'), { roads, mem: {} });
  const ok3 = once.st !== 'R'; if (!ok3) fails++;
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  A single wrong-way reading does not alarm (needs two) -> ${once.st}`);
  const parkedHere = E.evaluate([], { x: mid[0], y: mid[1], acc: 6, speed: 0, heading: null }, MON('12:00'), { roads, mem: {} });
  const ok4 = parkedHere.st !== 'R'; if (!ok4) fails++;
  console.log(`${ok4 ? 'PASS' : 'FAIL'}  Stopped on a one-way street (no direction) -> ${parkedHere.st}`);
}
// no entry ahead: approach a one-way street's exit end, heading into it against the flow
let entryCase = null;
for (const w of oneways) {
  const n = w.pts.length; if (n < 2) continue;
  const end = w.pts[n - 1], prev = w.pts[n - 2];
  const into = E.bearing(end, prev);                        // direction you'd drive to enter against the flow
  const h = into * Math.PI / 180, from = [end[0] - Math.sin(h) * 35, end[1] - Math.cos(h) * 35];
  const mem = {}; let a;
  for (let k = 0; k < 2; k++) a = E.evaluate([], { x: from[0], y: from[1], acc: 6, speed: 6, heading: into }, MON('12:00'), { roads, mem });
  if (a.st === 'E') { entryCase = { w, a }; break; }
}
{ const ok = !!entryCase; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Heading straight into a one-way street against the flow -> ${entryCase ? `${entryCase.a.st} ${entryCase.a.word} | ${entryCase.a.road} | puck: ${E.puckMessage(entryCase.a)}` : 'no case found'}`); }


// ---------- bus lanes ----------
console.log('\nBus lanes');
const lanes = E.loadBusLanes(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/bus_lanes.geojson'), 'utf8')));
console.log(`      ${lanes.length} bus lanes in operation at some time`);
const onLane = (l) => {  // a point on the lane and its direction of travel
  const line = l.lines[0];
  let best = 0, bi = 0;
  for (let i = 0; i < line.length - 1; i++) { const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]); if (L > best) { best = L; bi = i; } }
  const a = line[bi], b = line[bi + 1];
  let brg = E.bearing(a, b); if (E.angleDiff(brg, l.dir) > 90) brg = (brg + 180) % 360;
  return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, brg };
};
const peak = lanes.find(l => l.mon_fri === '07:00-10:00, 16:00-19:00' && l.length_m > 150);
const allDay = lanes.find(l => /24 Hours/.test(l.mon_fri) && l.length_m > 150);
const bl = (label, l, clock, headingDelta, want, wantText) => {
  const q = onLane(l);
  const a = E.evaluate([], { x: q.x, y: q.y, acc: 6, speed: 8, heading: (q.brg + headingDelta) % 360 }, clock, { bus: lanes });
  const ok = a.st === want && (!wantText || a.detail.includes(wantText));
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      -> ${a.st} ${a.kind} ${a.word} | ${a.road} | ${a.detail}\n      puck: ${E.puckMessage(a)}`);
};
bl(`${peak.road} (${peak.direction}), Mon 08:00, driving with the lane`, peak, MON('08:00'), 0, 'C', 'UNTIL 10:00');
bl(`${peak.road}, Mon 12:00`, peak, MON('12:00'), 0, 'O', 'UNTIL 16:00');
bl(`${peak.road}, Mon 06:50 (starts 07:00)`, peak, MON('06:50'), 0, 'W', 'FROM 07:00');
bl(`${peak.road}, Mon 08:00, driving the other way`, peak, MON('08:00'), 180, 'K');
bl(`${allDay.road} (24 hours), Sunday night`, allDay, { day: 0, min: 1380, term: false }, 0, 'C', '24 HOURS');

// ---------- pay-by-phone ----------
console.log('\nPay-by-phone');
const pbp = E.loadPayByPhone(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/pay_by_phone.geojson'), 'utf8')));
const spot = pbp.find(x => x.on_street && E.parkingAt(zones, x.m, { day: 1, min: 600 }).k === 'controlled');
{
  const a = E.evaluate([], { x: spot.m[0] + 10, y: spot.m[1], acc: 6, speed: 0 }, { day: 1, min: 600, term: true }, { zones, pbp, parked: true });
  const ok = a.st === 'P' && a.instr.includes(spot.code);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Parked next to ${spot.street}: ${a.word} | ${a.road}\n      ${a.instr}`);
}


{
  const at = (min, day = 1) => E.evaluate([], { x: spot.m[0] + 10, y: spot.m[1], acc: 6, speed: 0 }, { day, min, term: true }, { zones, pbp, parked: true });
  const pay = at(600), eve = at(1140), fri = at(1140, 5);
  const ok1 = pay.st === 'P' && pay.word === 'PAY' && /PAY UNTIL \d\d:\d\d/.test(pay.detail);
  const ok2 = eve.st === 'F' && /UNTIL TUE 08:30|UNTIL TUE/.test(eve.detail);
  const ok3 = fri.st === 'F' && /MON/.test(fri.detail);
  [ok1, ok2, ok3].forEach(ok => { if (!ok) fails++; });
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  Paid bay, Mon 10:00 -> ${pay.word} | ${pay.road} | ${pay.detail}\n      puck: ${E.puckMessage(pay)}`);
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  Same bay, Mon 19:00 -> ${eve.word} | ${eve.detail}`);
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  Same bay, Fri 19:00 -> ${eve.word} | ${fri.detail}`);
  // controlled zone, no pay bay on this street -> PERMIT, with the nearest pay bay mentioned
  let permit = null;
  for (const z of zones) {
    const [x0, y0, x1, y1] = z.bbox;
    for (let i = 1; i < 30 && !permit; i++) for (let j = 1; j < 30 && !permit; j++) {
      const q = [x0 + (x1 - x0) * i / 30, y0 + (y1 - y0) * j / 30];
      if (E.parkingAt(zones, q, { day: 1, min: 600 }).z !== z) continue;
      const nb = E.nearestPayByPhone(pbp, q, 250);
      if (nb && nb.d > 80) permit = E.evaluate([], { x: q[0], y: q[1], acc: 6, speed: 0 }, { day: 1, min: 600, term: true }, { zones, pbp, parked: true });
    }
    if (permit) break;
  }
  const ok4 = permit && permit.word === 'PERMIT' && /Nearest pay bay: PayByPhone location \d+/.test(permit.instr);
  if (!ok4) fails++;
  console.log(`${ok4 ? 'PASS' : 'FAIL'}  Controlled zone, no pay bay on the street -> ${permit && permit.word} | ${permit && permit.detail}\n      ${permit && permit.instr}`);
}

// ---------- speed limits ----------
console.log('\nSpeed limits');
const check = (label, ok, info) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${info ? `\n      ${info}` : ''}`); };
{
  const limits = {}; roads.ways.forEach(w => { limits[w.limit] = (limits[w.limit] || 0) + 1; });
  console.log(`      street segments by limit (mph): ${JSON.stringify(limits)}`);
  const w30 = roads.ways.find(w => w.limit === 30 && w.name && w.pts.length >= 2 && Math.hypot(w.pts[1][0] - w.pts[0][0], w.pts[1][1] - w.pts[0][1]) > 80);
  const a = w30.pts[0], b = w30.pts[1], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], hd = E.bearing(a, b);
  const run = mps => { const r = E.evaluate([], { x: mid[0], y: mid[1], acc: 5, speed: mps, heading: hd }, MON('12:00'), { roads, mem: {} }); return r; };
  const r1 = run(12), r2 = run(15), r3 = run(16.2);
  check(`${w30.name} is 30 mph; at ${r1.mph} mph not over`, r1.limit === 30 && r1.over === 0, E.puckMessage(r1));
  check(`at ${r2.mph} mph: over (amber)`, r2.over === 1);
  check(`at ${r3.mph} mph: well over (red)`, r3.over === 2);
}

// ---------- restrictions ----------
console.log('\nNo entry, bus gates and timed restrictions');
const restrGj = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/restrictions.geojson'), 'utf8'));
const restr = E.loadRestrictions(restrGj, feats, roads);
const kinds = {}; restr.forEach(r => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
console.log(`      ${restr.length} restrictions after removing ${restrGj.features.length - restr.length} that duplicate council School Streets: ${JSON.stringify(kinds)}`);
check('every timed restriction has readable times', restr.filter(r => r.when).every(r => r.cond.ok), restr.filter(r => r.when && !r.cond.ok).map(r => r.when).join(' | '));
const approach = (r, look = 40) => {  // a point before the start of the longest segment, heading along it
  let best = 0, bi = 0;
  for (let i = 0; i < r.pts.length - 1; i++) { const L = Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]); if (L > best) { best = L; bi = i; } }
  const a = r.pts[bi], b = r.pts[bi + 1], hd = E.bearing(a, b), h = hd * Math.PI / 180;
  return { pos: { x: a[0] - Math.sin(h) * look, y: a[1] - Math.cos(h) * look, acc: 5, speed: 8, heading: hd }, len: best, on: { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, acc: 5, speed: 8, heading: hd } };
};
{
  const gate = restr.filter(r => r.kind === 'BUS GATE' && r.road && !/^Near /.test(r.road)).map(r => ({ r, ...approach(r) })).sort((a, b) => b.len - a.len)[0];
  const a = E.evaluate([], gate.pos, MON('12:00'), { restr, mem: {} });
  check(`Approaching the bus gate on ${gate.r.road}`, a.st === 'E' && a.kind === 'BUS GATE', `${a.st} ${a.word} | ${a.road} | ${a.detail}\n      puck: ${E.puckMessage(a)}`);
  const mem = {}; let b;
  for (let k = 0; k < 2; k++) b = E.evaluate([], gate.on, MON('12:00'), { restr, mem, fixId: k });
  check(`Driving along the bus gate itself`, b.st === 'X', `${b.st} ${b.word} | ${b.kind} | ${b.detail}`);
}
{
  const sat = restr.find(r => /Sa 08:00-17:00/.test(r.when));
  if (sat) {
    const ap = approach(sat);
    const a1 = E.evaluate([], ap.pos, { day: 6, min: 600, term: true }, { restr, mem: {} });
    const a2 = E.evaluate([], ap.pos, { day: 1, min: 600, term: true }, { restr, mem: {} });
    check(`Timed no entry (${sat.road || 'unnamed'}, Sat 08:00-17:00): Saturday 10:00`, a1.st === 'E' && a1.detail.includes('17:00'), `${a1.st} ${a1.word} | ${a1.detail}`);
    check(`Same street on Monday: open`, a2.st === 'O', `${a2.st} ${a2.word} | ${a2.detail}`);
  }
}

// ---------- cameras ----------
console.log('\nCameras');
const cams = E.loadCameras(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/cameras.geojson'), 'utf8')));
{
  const q = cams[0];
  const hd = 45, h = hd * Math.PI / 180;
  const before = { x: q.m[0] - Math.sin(h) * 180, y: q.m[1] - Math.cos(h) * 180, acc: 5, speed: 13, heading: hd };
  const a = E.evaluate([], before, MON('12:00'), { cams, roads, mem: {} });
  check(`Camera ${q.id} 180 m ahead`, a.st === 'S' && Math.round(a.dist) === 180, `${a.st} ${a.kind} ${a.word} | ${a.road} | ${a.detail}\n      puck: ${E.puckMessage(a)}`);
  const after = { ...before, heading: (hd + 180) % 360 };
  const b = E.evaluate([], after, MON('12:00'), { cams, roads, mem: {} });
  check('Same place driving away from it: no camera alert', b.st !== 'S', `${b.st}`);
}

// ---------- yellow boxes ----------
console.log('\nYellow boxes');
const boxes = E.loadYellowBoxes(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/yellow_boxes.geojson'), 'utf8')));
{
  const bx = boxes.find(b => /BRIXTON/.test(b.junction)) || boxes[0];
  const hd = 0, before = { x: bx.c[0], y: bx.c[1] - 45, acc: 5, speed: 6, heading: hd };
  const a = E.evaluate([], before, MON('12:00'), { boxes, mem: {} });
  check(`45 m before ${bx.junction}`, a.st === 'Y', `${a.st} ${a.word} | ${a.road} | ${a.detail}\n      puck: ${E.puckMessage(a)}`);
  const inside = E.evaluate([], { x: bx.c[0], y: bx.c[1], acc: 5, speed: 3, heading: hd }, MON('12:00'), { boxes, mem: {} });
  check('Inside the box', inside.st === 'Y' && inside.detail.includes("DON'T STOP"), inside.detail);
}

// ---------- speed limits from TfL's map (OpenStreetMap was out of date) ----------
{
  const run = (lat, lng, hd) => { const m = E.toM(lng, lat); return E.evaluate([], { x: m[0], y: m[1], acc: 5, speed: 11, heading: hd }, MON('12:00'), { roads, mem: {} }); };
  const sh = run(51.4232, -0.1316, 180);
  check('Streatham High Road by Streatham Common, southbound: 20 mph (OpenStreetMap said 30)', sh.limit === 20, `limit ${sh.limit}, you ${sh.mph} mph -> over ${sh.over}`);
  const w = roads.ways.filter(x => x.name === 'Brixton Road' && x.pts.length >= 2).sort((a, b) => Math.hypot(b.pts[1][0] - b.pts[0][0], b.pts[1][1] - b.pts[0][1]) - Math.hypot(a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]))[0];
  const mid = [(w.pts[0][0] + w.pts[1][0]) / 2, (w.pts[0][1] + w.pts[1][1]) / 2];
  const bx = E.evaluate([], { x: mid[0], y: mid[1], acc: 5, speed: 11, heading: E.bearing(w.pts[0], w.pts[1]) }, MON('12:00'), { roads, mem: {} });
  check('Brixton Road: 20 mph (TfL map; OpenStreetMap said 30)', bx.limit === 20, `limit ${bx.limit}`);
}

// ---------- which parking app: PayByPhone street bays, RingGo car parks ----------
console.log('\nParking apps');
{
  const apps = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/parking_apps.json'), 'utf8'));
  const cps = E.loadCarParks(JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/car_parks.geojson'), 'utf8')));
  const cp = code => cps.find(c => c.code === code);
  const park = (m, clk, dx = 0) => E.evaluate([], { x: m[0] + dx, y: m[1], acc: 8, speed: 0 }, clk, { zones, pbp, cps, apps, parked: true });
  check('Street bays default to PayByPhone, car parks to RingGo', E.appFor(apps).name === 'PayByPhone' && E.appFor(apps, 'ringgo').name === 'RingGo');
  check('Old single-app file still works', E.appFor({ name: 'PayByPhone' }, 'ringgo').name === 'PayByPhone');

  // Kennington Park car park: no zone on the map there, so the car park is the answer
  const kp = park(cp('39079').m, MON('10:00'));
  check('In Kennington Park car park -> CAR PARK, RingGo 39079', kp.st === 'P' && kp.kind === 'CAR PARK' && kp.road === 'RINGGO 39079' && kp.pay.app.name === 'RingGo',
    `${kp.word} | ${kp.road} | ${kp.detail}\n      puck: ${E.puckMessage(kp)}\n      ${kp.instr}`);
  const ss = park(cp('828281').m, MON('10:00'));
  check("Sainsbury's Streatham Common -> RingGo 828281, £4.40 a day", ss.st === 'P' && ss.pay.code === '828281' && ss.instr.includes('£4.40'), `${ss.road} | ${ss.detail}`);

  // Cornwall Road: council pay bay (PayByPhone) is still the main answer, the RingGo car park is offered as well
  const cw = park(cp('32106').m, MON('10:00'), 25);
  check('Next to Cornwall Road car park, Mon 10:00 -> PayByPhone street bay first, RingGo car park as the other option',
    cw.pay && cw.pay.app.name === 'PayByPhone' && cw.alt && cw.alt.app.name === 'RingGo' && cw.alt.code === '32106',
    `${cw.word} | ${cw.road} | alt ${cw.alt && cw.alt.app.name} ${cw.alt && cw.alt.code}\n      ${cw.instr}`);

  // Ferndale Road car park sits in zone B: permit street, car park suggested
  const fr = park(cp('38925').m, MON('10:00'), 150);
  check('150 m from Ferndale Road car park in zone B, Mon 10:00 -> PERMIT and the car park suggested',
    (fr.word === 'PERMIT' || fr.word === 'RESIDENTS' || fr.word === 'PAY') && fr.alt && fr.alt.code === '38925',
    `${fr.word} | ${fr.road} | alt ${fr.alt && fr.alt.code} (${fr.alt && Math.round(fr.alt.carPark.d)} m)\n      ${fr.instr}`);
  // Wandsworth street bays next door: RingGo, not PayByPhone
  const at = (lat, lng, clk) => { const m = E.toM(lng, lat); return E.evaluate([], { x: m[0], y: m[1], acc: 8, speed: 0 }, clk, { zones, pbp, cps, apps, parked: true }); };
  const th = at(51.47597, -0.13709, MON('10:00'));
  check('Thessaly Road (Wandsworth B8), Mon 10:00 -> PAY, RingGo 11737, until 18:30', th.word === 'PAY' && th.pay.app.name === 'RingGo' && th.road === 'RINGGO 11737' && th.detail.includes('18:30'), `${th.road} | ${th.detail}\n      puck: ${E.puckMessage(th)}`);
  const thSun = at(51.47597, -0.13709, { day: 0, min: 600, term: true });
  check('Thessaly Road, Sunday -> FREE until Mon 08:30', thSun.st === 'F' && thSun.detail === 'FREE UNTIL MON 08:30', thSun.detail);
  const gk = at(51.45028, -0.14287, { day: 5, min: 1100, term: true });
  check('Gaskarth Road, Fri 18:20 (RingGo lists nothing) -> CHECK THE SIGNS', gk.word === 'CHECK' && gk.detail === 'CHECK THE SIGNS', gk.instr);
  const gk2 = at(51.45028, -0.14287, { day: 4, min: 1100, term: true });
  check('Gaskarth Road, Thu 18:20 -> FREE', gk2.st === 'F', gk2.detail);
  // Angell Town Estate car park: charged hours, free Sundays, unknown evenings
  const an = t => at(51.46822, -0.10757, t);
  const a1 = an(MON('10:00')), a2 = an({ day: 0, min: 600, term: true }), a3 = an(MON('20:30'));
  check('Angell Town Estate car park, Mon 10:00 -> PAY until 20:00, max 3 h', a1.kind === 'CAR PARK' && a1.word === 'PAY' && a1.detail === 'PAY UNTIL 20:00 - MAX 3 H', `${a1.detail}\n      puck: ${E.puckMessage(a1)}`);
  check('Angell Town, Sunday -> FREE (RingGo lists Sundays free)', a2.st === 'F' && a2.kind === 'CAR PARK', a2.detail);
  check('Angell Town, Mon 20:30 -> CHECK THE SIGNS, not FREE (may be residents only)', a3.word === 'CHECK', a3.instr);
  const msg = E.puckMessage(kp).split('|');
  check('Puck message for a car park has 10 fields and word PAY', msg.length === 10 && msg[1] === 'P' && msg[7] === 'PAY', E.puckMessage(kp));
}

// ---------- long bus lanes: warn once, then a quiet reminder ----------
console.log('\nLong bus lanes');
{
  const bus = lanes;
  const bx = bus.filter(l => l.road === 'Brixton Road' && l.direction === 'South');
  const dir = bx[0].dir, ux = Math.sin(dir * Math.PI / 180), uy = Math.cos(dir * Math.PI / 180);
  const pts = bx.flatMap(l => l.lines.flat()).sort((a, b) => (a[0] * ux + a[1] * uy) - (b[0] * ux + b[1] * uy));
  const route = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d < seg; d += 10) route.push([a[0] + (b[0] - a[0]) * d / seg, a[1] + (b[1] - a[1]) * d / seg]);
  }
  const mem = {}, voice = E.makeVoice(120000), states = [];
  voice({ key: 'start', st: 'N' }, 0);
  let busSaid = 0;
  for (let i = 1; i < route.length; i++) {
    const hd = E.bearing(route[i - 1], route[i]);
    const a = E.evaluate([], { x: route[i][0], y: route[i][1], acc: 6, speed: 10, heading: hd }, MON('08:00'), { bus, mem, fixId: i });
    if (voice(a, i * 1000) && a.kind === 'BUS LANE') busSaid++;
    states.push(a.st);
  }
  const quiet = states.slice(10).filter(s => s === 'L').length, shown = states.slice(10).length;
  check(`Brixton Road southbound, ${Math.round(route.length * 10)} m beside bus lanes, Mon 08:00: bus lane spoken once`, busSaid === 1, `spoken ${busSaid} times`);
  check('After the first few seconds the screen is the quiet reminder (L), not CLOSED', states.slice(0, 8).every(s => s === 'C') && quiet / shown > 0.85,
    `first 8 s: ${states.slice(0, 8).join('')}; after: ${quiet}/${shown} quiet`);
  const v = E.makeVoice(120000); v({ key: 'x', st: 'N' }, 0);
  const y = { key: 'Y|BOX|A', st: 'Y' }, k = { key: 'K', st: 'K' };
  const r = [v(y, 1000), v(k, 2000), v(y, 3000), v(k, 4000), v(y, 200000), v({ key: 'C|q', st: 'C', quiet: true }, 201000)];
  check('Voice: same alert not repeated within 2 minutes, quiet alerts never spoken', r.join() === 'true,false,false,false,true,false', r.join());
}

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
