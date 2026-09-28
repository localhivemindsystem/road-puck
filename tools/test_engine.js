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

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
