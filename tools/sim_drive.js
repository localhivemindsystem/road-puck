// Drive a simulated car along a bus lane corridor and count what the driver would see and hear.
// Run:  node tools/sim_drive.js ["Road name"] [direction]
const fs = require('fs'), path = require('path');
const E = require('../docs/engine.js');
const L = f => JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data', f), 'utf8'));
const bus = E.loadBusLanes(L('bus_lanes.geojson'));
const roads = E.loadRoads(L('basemap.json'));
const feats = E.loadFeatures(L('school_streets.geojson'));
const boxes = E.loadYellowBoxes(L('yellow_boxes.geojson'));
const cams = E.loadCameras(L('cameras.geojson'));
const restr = E.loadRestrictions(L('restrictions.geojson'), feats, roads);

// group lanes into corridors by road + direction and chain their points in travel order
const groups = {};
for (const l of bus) (groups[l.road + '|' + l.direction] = groups[l.road + '|' + l.direction] || []).push(l);
const len = ls => ls.reduce((s, l) => s + l.length_m, 0);
const want = process.argv[2], wdir = process.argv[3];
const key = want ? Object.keys(groups).find(k => k.startsWith(want + '|') && (!wdir || k.endsWith('|' + wdir))) : Object.keys(groups).sort((a, b) => len(groups[b]) - len(groups[a]))[0];
const lanes = groups[key];
const dir = lanes[0].dir;
// order all points along the travel direction
const pts = lanes.flatMap(l => l.lines.flat());
const ux = Math.sin(dir * Math.PI / 180), uy = Math.cos(dir * Math.PI / 180);
pts.sort((a, b) => (a[0] * ux + a[1] * uy) - (b[0] * ux + b[1] * uy));
// resample every 10 m (1 s at 10 m/s), starting 60 m before the first point
const path2 = [];
const first = pts[0];
for (let d = -60; d < 0; d += 10) path2.push([first[0] + ux * d, first[1] + uy * d]);
for (let i = 0; i < pts.length - 1; i++) {
  const a = pts[i], b = pts[i + 1], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let t = 0; t < seg; t += 10) path2.push([a[0] + (b[0] - a[0]) * t / seg, a[1] + (b[1] - a[1]) * t / seg]);
}
const clock = { day: 1, min: 8 * 60, term: true };   // Monday 08:00, most lanes in force
const mem = {}, track = E.makeTracker(4000), voice = E.makeVoice(120000);
voice({ key: 'start', st: 'N' }, 0);   // the app stays silent for whatever shows first; start clean
let says = 0, changes = 0, last = '';
const log = [];
for (let i = 1; i < path2.length; i++) {
  const p = path2[i], q = path2[i - 1];
  const heading = E.bearing(q, p);
  const pos = { x: p[0], y: p[1], acc: 6, speed: 10, heading };
  const a = track(E.evaluate(feats, pos, clock, { roads, bus, boxes, cams, restr, mem, fixId: i }), i * 1000);
  const voiced = voice(a, i * 1000 + 1);
  if (voiced) { says++; log.push(`${i}s SAY  ${a.st} ${a.kind} ${a.word} | ${a.road} | ${a.detail}`); }
  const shown = a.st + ' ' + a.kind + ' ' + a.word;
  if (shown !== last) { changes++; if (!voiced) log.push(`${i}s show ${shown} | ${a.road}`); last = shown; }
}
console.log(`${key}: ${lanes.length} lane pieces, ${Math.round(len(lanes))} m of lane, drove ${path2.length * 10} m at 10 m/s, Mon 08:00`);
console.log(`voice alerts: ${says}   screen changes: ${changes}`);
console.log(log.slice(0, 60).join('\n'));
