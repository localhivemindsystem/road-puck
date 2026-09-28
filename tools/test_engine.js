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

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
