/* Road Puck alert engine.
   Pure logic, no page code: positions in, one alert out.
   Used by the phone app (docs/index.html) and by tools/test_engine.js. */
(function (root) {
  'use strict';

  // ---- local metric grid centred on Lambeth ----
  const LON0 = -0.115, LAT0 = 51.455;
  const KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KY = 110540;
  const toM = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const toLL = (x, y) => [LON0 + x / KX, LAT0 + y / KY];

  // ---- features ----
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

  function nearest(f, p) {
    let best = Infinity, pt = null;
    for (const s of f.segs) {
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i], b = s[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1);
        t = Math.max(0, Math.min(1, t));
        const x = a[0] + t * dx, y = a[1] + t * dy;
        const d = Math.hypot(x - p[0], y - p[1]);
        if (d < best) { best = d; pt = [x, y]; }
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

  // ---- geometry helpers ----
  const bearing = (from, to) => (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180 / Math.PI + 360) % 360;
  const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  // ---- the decision ----
  // pos = { x, y (metres), acc (m), speed (m/s or null), heading (deg or null) }
  // Returns { st, severity, kind, word, road, roadShort, dist, detail, puckDetail, instr, f, warnR, inR }
  const SEVERITY = { N: 0, K: 1, G: 1, O: 2, W: 3, C: 4, X: 5 };

  function evaluate(feats, pos, clock) {
    if (!pos) return mk('N', { word: 'READY', road: 'TAP START GPS', detail: '', instr: 'Mount the phone, then tap START GPS.' });
    if (pos.acc > 100) return mk('G', { word: 'NO GPS', road: '', detail: `GPS \u00b1${Math.round(pos.acc)} M`, puckDetail: 'WAITING FOR SIGNAL', instr: 'Waiting for a better GPS signal.', acc: pos.acc });

    const acc = Math.min(pos.acc || 0, 50);
    const moving = pos.speed != null && pos.speed >= 2.5 && pos.heading != null;
    const speed = pos.speed != null ? pos.speed : 0;
    const warnR = Math.min(600, Math.max(250, 250 + speed * 20)) + acc;  // look-ahead geofence
    const inR = 35 + Math.min(pos.acc || 0, 40);                        // "you're at it" geofence
    const p = [pos.x, pos.y];

    const c = feats.map(f => {
      const n = nearest(f, p);
      const ahead = moving ? angleDiff(pos.heading, bearing(p, n.pt)) <= 75 || n.d < inR : null;
      const etaMin = n.d / Math.max(speed, 3) / 60;  // cautious: slow London traffic arrives later
      const now = status(f, clock);
      const arrive = status(f, { ...clock, min: clock.min + etaMin });
      return { f, d: n.d, pt: n.pt, ahead, now, arrive, etaMin };
    }).sort((a, b) => a.d - b.d);

    const extra = { acc: pos.acc, warnR, inR };
    const at = c.find(r => r.d <= inR && r.now.k === 'closed');
    if (at) return mk('X', {
      ...extra, f: at.f, dist: at.d, word: "DON'T ENTER",
      detail: `CLOSED UNTIL ${fmt(at.now.until)}`,
      instr: `You're at the ${at.f.road} closure. Don't drive in.`,
    });

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
    const closing = near.find(r => r.now.k === 'closing');
    if (closing) return mk('W', {
      ...extra, f: closing.f, dist: closing.d, word: 'CLOSING',
      detail: `CLOSES IN ${closing.now.inMin} MIN`,
      instr: `Avoid ${closing.f.road} from ${fmt(closing.now.at)}.`,
    });

    const open = c.find(r => r.d <= warnR && r.now.k === 'open' && r.ahead !== false);
    if (open) {
      const st = open.now;
      const detail = st.allDay ? `OPEN ALL DAY \u00b7 ${st.why}` : st.next !== undefined ? `NEXT CLOSURE ${fmt(st.next)}` : 'NO MORE CLOSURES TODAY';
      return mk('O', {
        ...extra, f: open.f, dist: open.d, word: 'OPEN', detail,
        puckDetail: st.allDay ? st.why : st.next !== undefined ? `NEXT CLOSURE ${fmt(st.next)}` : 'OPEN REST OF DAY',
        instr: `${open.f.road} is open to traffic.`,
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

  function mk(st, o) {
    const f = o.f;
    return {
      st, severity: SEVERITY[st],
      kind: f ? f.kind : (st === 'K' ? 'SCHOOL STREETS' : 'ROAD PUCK'),
      word: o.word,
      road: o.road != null ? o.road : (f ? f.road.toUpperCase() : ''),
      roadShort: o.road != null ? o.road : (f ? f.road_short : ''),
      dist: o.dist != null ? o.dist : null,
      detail: o.detail || '',
      puckDetail: o.puckDetail || o.detail || '',
      instr: o.instr || '',
      acc: o.acc != null ? o.acc : null,
      warnR: o.warnR, inR: o.inR,
      f: f || null,
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
        if (!last || next.st !== last.st || (next.f && last.f && next.f.id !== last.f.id)) lastAt = nowMs;
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
    const dist = a.dist != null && (a.st === 'C' || a.st === 'W' || a.st === 'O' || a.st === 'X') ? Math.round(a.dist) : '';
    const detail = a.st === 'N' ? 'START GPS ON PHONE' : a.puckDetail;
    const acc = a.acc != null ? Math.round(a.acc) : '';
    return ['1', st, clean(a.st === 'N' ? '' : a.roadShort), dist, clean(detail), acc, clean(a.kind)].join('|');
  }

  const api = { LON0, LAT0, toM, toLL, loadFeatures, nearest, londonNow, inTerm, status, evaluate, makeTracker, puckMessage, fmt, fmtDist, bearing, angleDiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoadEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
