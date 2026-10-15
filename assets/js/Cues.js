'use strict';

/**
 * Cues — everything that ends up as a course point.
 *
 * Two kinds, anchored differently on purpose:
 *
 *   · Turn cues are derived from the router's hints every time the track is
 *     built. They are geography: move a waypoint and they move with the road.
 *   · Custom cues (eat, drink, target power, notes) are stored on the route as
 *     { id, type, atM, label, note, endM?, watts?, series? } — anchored by
 *     distance from the start, because "eat every 20 km" is about distance,
 *     not about the corner you happen to be at when it comes up.
 *
 * Course-point types are the TCX CoursePointType_t vocabulary (Garmin's TCX
 * v2 schema), which is also what Garmin's FIT course points and most GPX
 * consumers recognise. There is no "power" type; power cues are Generic with
 * the watts in the name.
 */
const Cues = (() => {

  const TYPES = {
    eat:      { name: 'Eat',          tcx: 'Food',     color: '#c98500', glyph: 'E' },
    drink:    { name: 'Drink',        tcx: 'Water',    color: '#3987e5', glyph: 'D' },
    power:    { name: 'Target power', tcx: 'Generic',  color: '#d95926', glyph: 'W' },
    note:     { name: 'Note',         tcx: 'Generic',  color: '#8b949e', glyph: 'i' },
    danger:   { name: 'Danger',       tcx: 'Danger',   color: '#d03b3b', glyph: '!' },
    summit:   { name: 'Summit',       tcx: 'Summit',   color: '#199e70', glyph: '▲' },
    water:    { name: 'Water stop',   tcx: 'Water',    color: '#3987e5', glyph: 'H' },
    left:     { name: 'Left',         tcx: 'Left',     color: '#e6edf3', glyph: '←', turn: true },
    right:    { name: 'Right',        tcx: 'Right',    color: '#e6edf3', glyph: '→', turn: true },
    straight: { name: 'Straight',     tcx: 'Straight', color: '#e6edf3', glyph: '↑', turn: true },
    generic:  { name: 'Cue',          tcx: 'Generic',  color: '#e6edf3', glyph: '•', turn: true },
  };

  /** The types a person can add by hand, in menu order. */
  const CUSTOM = ['eat', 'drink', 'power', 'note', 'danger', 'summit', 'water'];

  let seq = 0;
  function newId() { return 'c' + Date.now().toString(36) + (seq++).toString(36); }

  // ── Turn cues ─────────────────────────────────────────────────────────────

  /**
   * Router hints → turn cues on the built track.
   * Slight turns and keep-left/right are noise on most roads, so they are
   * only included when asked for.
   */
  function turns(track, { slight = false } = {}) {
    const out = [];
    for (const h of track.hints) {
      const c = Router.CMD[h.cmd];
      let type = null, label = null;
      switch (c) {
        case 'TL': case 'TSHL': type = 'left'; label = c === 'TSHL' ? 'Sharp left' : 'Left'; break;
        case 'TR': case 'TSHR': type = 'right'; label = c === 'TSHR' ? 'Sharp right' : 'Right'; break;
        case 'TLU': case 'TRU': case 'TU': type = 'generic'; label = 'U-turn'; break;
        case 'RNDB': case 'RNLB': type = 'generic'; label = 'Roundabout' + (h.exit ? ' exit ' + h.exit : ''); break;
        case 'EL': if (slight) { type = 'left'; label = 'Exit left'; } break;
        case 'ER': if (slight) { type = 'right'; label = 'Exit right'; } break;
        case 'TSLL': case 'KL': if (slight) { type = 'left'; label = c === 'KL' ? 'Keep left' : 'Bear left'; } break;
        case 'TSLR': case 'KR': if (slight) { type = 'right'; label = c === 'KR' ? 'Keep right' : 'Bear right'; } break;
        default: break;
      }
      if (!type) continue;
      out.push({ id: 'turn-' + h.i, type, atM: track.d[h.i], label, auto: true });
    }
    return out;
  }

  /**
   * Turns found from the shape of a track, for imported tracks that came
   * with no router hints. Heading 30 m before against 30 m after; a turn is a
   * local peak above 60°, and turns closer than 60 m are one turn.
   * Returned as ordinary custom cues, so the ones it gets wrong can be deleted.
   */
  function detectTurns(track, { minAngle = 60, arm = 30, spacing = 60 } = {}) {
    const n = track.n, d = track.d;
    const ang = new Float64Array(n);
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      while (a < i && d[i] - d[a] > arm) a++;
      while (b < n - 1 && d[b] - d[i] < arm) b++;
      if (a === i || b === i || d[i] - d[a] < arm * 0.6 || d[b] - d[i] < arm * 0.6) continue;
      const h1 = Geo.bearing(track.lat[a], track.lon[a], track.lat[i], track.lon[i]);
      const h2 = Geo.bearing(track.lat[i], track.lon[i], track.lat[b], track.lon[b]);
      ang[i] = Geo.turn(h1, h2);
    }
    const out = [];
    let i = 0;
    while (i < n) {
      if (Math.abs(ang[i]) < minAngle) { i++; continue; }
      let j = i, peak = i;
      while (j < n && Math.abs(ang[j]) >= minAngle && Math.sign(ang[j]) === Math.sign(ang[i])) {
        if (Math.abs(ang[j]) > Math.abs(ang[peak])) peak = j;
        j++;
      }
      const prev = out[out.length - 1];
      if (!prev || d[peak] - prev.atM >= spacing) {
        const right = ang[peak] > 0;
        out.push({ id: newId(), type: right ? 'right' : 'left', atM: d[peak],
          label: Math.abs(ang[peak]) > 135 ? 'U-turn' : right ? 'Right' : 'Left' });
      }
      i = j;
    }
    return out;
  }

  // ── Custom cues ───────────────────────────────────────────────────────────

  function make(type, atM, extra = {}) {
    return { id: newId(), type, atM: Math.max(0, atM), label: extra.label || TYPES[type].name, ...extra };
  }

  /**
   * A repeating series: every `everyM` from `fromM` up to `toM` (inclusive of
   * the start, exclusive of anything past the end). All share a `series` id
   * so they can be removed together.
   */
  function series(type, { everyM, fromM, toM, label, note }) {
    if (!(everyM > 0)) throw new Error('The interval has to be more than zero.');
    if (!(toM > fromM)) return [];
    const sid = 's' + newId();
    const out = [];
    for (let m = fromM, k = 1; m <= toM + 1e-6 && out.length < 500; m += everyM, k++) {
      out.push(make(type, m, { label: label || TYPES[type].name, note: note || '', series: sid, seriesN: k }));
    }
    return out;
  }

  /** A target-power cue held from `atM` to `endM`. */
  function power(atM, endM, watts, ftp) {
    const w = Math.round(watts);
    const pct = ftp > 0 ? Math.round(100 * w / ftp) : null;
    const span = endM > atM ? endM - atM : 0;
    return make('power', atM, {
      watts: w, endM: span ? endM : null,
      label: w + ' W',
      note: 'Hold ' + w + ' W' + (pct ? ' (' + pct + '% FTP)' : '') +
        (span ? ' for ' + (span / 1000).toFixed(1) + ' km' : ''),
    });
  }

  /**
   * The full cue list for a track: custom cues that fall on it, plus turns,
   * plus an "End" cue after each power block. Sorted by distance.
   */
  function all(route, track, opts = {}) {
    const out = [];
    for (const c of route.cues || []) {
      if (c.atM > track.length + 1) continue;           // off the end after an edit
      out.push(c);
      if (c.type === 'power' && c.endM && c.endM < track.length - 1) {
        out.push({ id: c.id + '-end', type: 'power', atM: c.endM, label: 'End ' + c.watts + ' W', note: 'End of the ' + c.watts + ' W block', auto: true, isEnd: true });
      }
    }
    if (opts.turns !== false) out.push(...turns(track, { slight: !!opts.slight }));
    out.sort((a, b) => a.atM - b.atM);
    return out;
  }

  /** Custom cues left past the end of the track by an edit. */
  function stranded(route, track) {
    return (route.cues || []).filter(c => c.atM > track.length + 1);
  }

  /** Target watts at each track sample from the power cues, or NaN. */
  function powerAt(route, track) {
    const w = new Float64Array(track.n).fill(NaN);
    for (const c of route.cues || []) {
      if (c.type !== 'power' || !(c.watts > 0)) continue;
      const end = c.endM || track.length;
      for (let i = 0; i < track.n; i++) if (track.d[i] >= c.atM && track.d[i] < end) w[i] = c.watts;
    }
    return w;
  }

  /**
   * Climbs: rises from a low point to a high point, at least `minLen` long and
   * `minGrade` steep on average. A dip doesn't end a climb unless it gives
   * back more than `slack` metres or a fifth of the height gained so far,
   * whichever is more — a road that drops 20 m into a creek halfway up a
   * 300 m climb is still one climb to the person riding it.
   * Returned as { fromM, toM, gain, grade }.
   */
  function climbs(track, { minLen = 2000, minGrade = 0.03, slack = 15 } = {}) {
    if (!track.hasEle || track.n < 3) return [];
    const out = [];
    let lo = 0, hi = 0;
    const close = () => {
      // The climb starts the last time the road was near the valley floor, not
      // at the valley floor itself: 5 km of rolling flat before the ramp is not
      // part of the climb.
      let s = hi;
      while (s > lo && track.ele[s - 1] > track.ele[lo] + slack) s--;
      if (s > lo) s--;
      const len = track.d[hi] - track.d[s], gain = track.ele[hi] - track.ele[s];
      if (len >= minLen && gain / len >= minGrade) out.push({ fromM: track.d[s], toM: track.d[hi], gain, grade: gain / len });
    };
    for (let i = 1; i < track.n; i++) {
      const e = track.ele[i];
      if (e > track.ele[hi]) hi = i;
      if (e < track.ele[lo] && hi === lo) { lo = hi = i; continue; }
      if (track.ele[hi] - e > Math.max(slack, 0.2 * (track.ele[hi] - track.ele[lo]))) {
        if (hi > lo) close();
        lo = hi = i;
      } else if (e < track.ele[lo]) { lo = hi = i; }
    }
    if (hi > lo) close();
    return out;
  }

  // ── Timing ────────────────────────────────────────────────────────────────

  /**
   * Estimated elapsed seconds at every track sample, from power: the target
   * of whatever power cue covers the sample, otherwise `ridePct` of FTP.
   * Grade is taken over ±50 m so DEM steps don't produce walls. Downhill speed
   * is capped, because nobody descends at terminal velocity.
   */
  function timing(route, track, cfg) {
    const n = track.n;
    const t = new Float64Array(n);
    if (n < 2) return t;
    const mass = cfg.mass || 78;
    const cda = cfg.cda || 0.32;
    const crr = (cfg.crr || 0.004) + (Router.terrain(route.profile).crr || 0);
    const base = (cfg.ftp || 250) * (cfg.ridePct || 70) / 100;
    const vmax = (cfg.maxDescent || 55) / 3.6;
    const target = powerAt(route, track);
    const g = 9.81, rho = 1.2, eff = 0.97;

    let a = 0, b = 0;
    for (let i = 1; i < n; i++) {
      const dd = track.d[i] - track.d[i - 1];
      if (dd <= 0) { t[i] = t[i - 1]; continue; }
      const mid = (track.d[i] + track.d[i - 1]) / 2;
      while (a < n - 1 && track.d[a] < mid - 50) a++;
      while (b < n - 1 && track.d[b] < mid + 50) b++;
      const span = track.d[b] - track.d[a];
      const grade = span > 10 && track.hasEle ? (track.ele[b] - track.ele[a]) / span : 0;
      const th = Math.atan(grade);
      const P = (isFinite(target[i]) ? target[i] : base) * eff;
      const Fg = mass * g * (Math.sin(th) + crr * Math.cos(th));
      // Solve P = (Fg + ½ρCdA v²) v by bisection: monotone in v whenever there is a solution.
      let lo = 0.3, hi = 30;
      for (let k = 0; k < 40; k++) {
        const v = (lo + hi) / 2;
        if ((Fg + 0.5 * rho * cda * v * v) * v > P) hi = v; else lo = v;
      }
      const v = Math.min(vmax, Math.max(1.0, (lo + hi) / 2));
      t[i] = t[i - 1] + dd / v;
    }
    return t;
  }

  function timeAt(track, times, atM) {
    const p = RouteStore.positionAt(track, atM);
    if (!p || track.n < 2) return 0;
    const j = Math.min(p.i + 1, track.n - 1);
    return times[p.i] + (times[j] - times[p.i]) * p.f;
  }

  // ── Short names ───────────────────────────────────────────────────────────

  /**
   * A course point name a head unit can show whole. TCX caps it at 10
   * characters; Garmin truncates GPX names to about the same.
   */
  function shortName(c) {
    if (c.type === 'power' && !c.isEnd) {
      const km = c.endM ? Math.round((c.endM - c.atM) / 1000) : 0;
      const s = c.watts + 'W' + (km ? ' ' + km + 'km' : '');
      return s.length <= 10 ? s : (c.watts + 'W').slice(0, 10);
    }
    if (c.type === 'power' && c.isEnd) return ('End ' + c.watts + 'W').slice(0, 10);
    const s = String(c.label || TYPES[c.type].name).replace(/[^\x20-\x7e]/g, '').trim();
    return (s || TYPES[c.type].name).slice(0, 10);
  }

  return { TYPES, CUSTOM, turns, detectTurns, make, series, power, climbs, all, stranded, powerAt, timing, timeAt, shortName, newId };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Cues;
