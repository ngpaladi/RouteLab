'use strict';

/**
 * Settings — small persistent preference bag in localStorage.
 * Loaded on every page, because the settings drawer lives in the layout.
 *
 * STORAGE IS SHARED WITH CRITLAB AND CROSSLAB. All three tools are served from
 * the same origin (www.noahpaladino.com/CritLab, /CrossLab, /RouteLab), so
 * localStorage is one bag. The blob key, the API-key slot and every key
 * CritLab already defines keep their names and meanings here: paste the
 * intervals.icu key once and every tool sees it; set your FTP in one and the
 * others agree.
 *
 * Rules that keep that true:
 *   · only ADD keys to DEFAULTS, never change what an existing one means
 *   · RouteLab-only keys are prefixed `rl` so they are recognisable in a dump
 *   · `reset()` removes RouteLab's own keys only; it never touches the
 *     intervals.icu settings, the rider numbers or the other tools' keys
 *   · unknown keys in the stored blob survive a round trip (all() merges the
 *     stored object over DEFAULTS, set() merges on top of that)
 */
const Settings = (() => {
  const KEY = 'cl-settings';

  // The intervals.icu key is deliberately NOT part of the settings blob: it
  // gets its own lifetime (session or persistent), can be purged on its own,
  // and never rides along in a dump of `cl-settings`. Same slot as CritLab.
  const ICU_KEY_STORE = 'cl-icu-key';

  const DEFAULTS = {
    // ── Shared with CritLab and CrossLab: identical names and meanings ────
    icuAthlete: '', icuAthleteName: '',
    icuKeyPersist: 'local',        // 'local' = remembered · 'session' = until the tab closes
    mass: 78,                      // rider + bike, kg
    crr: 0.004, cda: 0.32,         // road rolling resistance, CdA m² (CritLab may have fitted it)
    ftp: 250, ftpUserSet: false,

    // ── RouteLab only ─────────────────────────────────────────────────────
    rlProfile: 'fastbike',         // BRouter profile for new legs, or 'straight'
    rlUnits: 'km',                 // 'km' | 'mi'
    rlTiles: 'cyclosm',            // basemap, a key of TileMap.LAYERS — the cycle map by default
    rlTrails: true,                // draw trail difficulty ratings over the map
    rlDirt: true,                  // draw dirt roads over the map (gravel and MTB levels only)
    rlTurnCues: true,              // put the router's turns into the export
    rlSlightTurns: false,          // …including "bear left/right" and keep-left/right
    rlRidePct: 70,                 // % of FTP the time estimate assumes outside power cues
    rlMaxDescent: 55,              // km/h — no faster than this downhill, whatever the physics says
    rlShowTurns: false,            // list and draw the router's turns alongside your own cues
    rlWelcomeSeen: false, rlTourDone: false,
  };

  const RESETTABLE = ['rlProfile', 'rlUnits', 'rlTiles', 'rlTrails', 'rlDirt', 'rlTurnCues', 'rlSlightTurns', 'rlShowTurns', 'rlRidePct', 'rlMaxDescent'];

  let cache = null;
  let memKey = '';

  function store(kind) {
    try {
      const s = kind === 'session' ? sessionStorage : localStorage;
      if (!s) return null;
      const probe = '__cl_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_) { return null; }
  }

  /** Read the key from wherever it was put. Session wins — it is the fresher one. */
  function getIcuKey() {
    try {
      const s = store('session'), l = store('local');
      const found = (s && s.getItem(ICU_KEY_STORE)) || (l && l.getItem(ICU_KEY_STORE)) || '';
      return found || memKey;
    } catch (_) { return memKey; }
  }

  function setIcuKey(key, persist) {
    const how = persist || get('icuKeyPersist') || 'local';
    memKey = key || '';
    try { const l = store('local'); if (l) l.removeItem(ICU_KEY_STORE); } catch (_) {}
    try { const s = store('session'); if (s) s.removeItem(ICU_KEY_STORE); } catch (_) {}
    if (!key) return;
    try {
      const target = store(how === 'session' ? 'session' : 'local');
      if (target) target.setItem(ICU_KEY_STORE, key);
    } catch (_) {}
  }

  function forgetIcuKey() { setIcuKey(''); }

  function all() {
    if (cache) return cache;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
    // Earlier CritLab builds kept the key inside the blob. Move it out.
    if (stored.icuKey) {
      const legacy = stored.icuKey;
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
      setIcuKey(legacy, cache.icuKeyPersist);
    } else {
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
    }
    return cache;
  }

  function get(k) {
    const s = all();
    return k === 'icuKey' ? getIcuKey() : s[k];
  }

  function set(patch) {
    const next = { ...patch };
    if ('icuKey' in next) {
      setIcuKey(next.icuKey, next.icuKeyPersist || get('icuKeyPersist'));
      delete next.icuKey;
    }
    cache = { ...all(), ...next };
    delete cache.icuKey;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
    if (next.icuKeyPersist) {
      const existing = getIcuKey();
      if (existing) setIcuKey(existing, next.icuKeyPersist);
    }
    return cache;
  }

  function reset() {
    const keep = { ...all() };
    for (const k of RESETTABLE) delete keep[k];
    cache = null;
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch (_) {}
    return all();
  }

  return { all, get, set, reset, DEFAULTS, RESETTABLE, getIcuKey, setIcuKey, forgetIcuKey, ICU_KEY_STORE, KEY };
})();

/**
 * Local — RouteLab's own small localStorage slots, outside the shared blob.
 *
 * Where the map was left and which route was open change every time someone
 * pans or switches route. Writing those into `cl-settings` would make RouteLab
 * the chatty writer of a blob that an open CritLab or CrossLab tab holds a
 * cached copy of — and that tab's next save would undo them, or they its.
 * Separate keys keep the shared blob for things that rarely change.
 */
const Local = (() => {
  const VIEW = 'rl-view', CURRENT = 'rl-current';
  function read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }
  function write(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (_) {}
  }
  return {
    view: () => read(VIEW), setView: v => write(VIEW, v),
    current: () => read(CURRENT), setCurrent: id => write(CURRENT, id || null),
    VIEW, CURRENT,
  };
})();

/**
 * Geo — the handful of spherical-earth helpers everything else uses.
 */
const Geo = (() => {
  const R = 6371008.8;
  const rad = Math.PI / 180;

  function dist(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Initial bearing, degrees clockwise from north. */
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
    const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
      Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  /** Signed smallest turn from heading a to heading b, -180..180, + = right. */
  function turn(a, b) { return ((b - a + 540) % 360) - 180; }

  /** Points every `step` metres along a straight line, endpoints included. */
  function densify(a, b, step) {
    const d = dist(a.lat, a.lon, b.lat, b.lon);
    const n = Math.max(1, Math.ceil(d / step));
    const out = [];
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      out.push([a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, null]);
    }
    return out;
  }

  /** Douglas–Peucker in a local flat projection; keeps [lat, lon, ele] rows. */
  function simplify(rows, tol) {
    if (rows.length < 3) return rows.slice();
    const lat0 = rows[0][0] * rad;
    const X = rows.map(r => r[1] * rad * Math.cos(lat0) * R);
    const Y = rows.map(r => r[0] * rad * R);
    const keep = new Uint8Array(rows.length);
    keep[0] = keep[rows.length - 1] = 1;
    const stack = [[0, rows.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1, bi = -1;
      const dx = X[b] - X[a], dy = Y[b] - Y[a], L = Math.hypot(dx, dy);
      for (let i = a + 1; i < b; i++) {
        // A loop starts and ends in the same place: measure from the point, not the line.
        const d = L < 1e-6 ? Math.hypot(X[i] - X[a], Y[i] - Y[a])
          : Math.abs(dy * (X[i] - X[a]) - dx * (Y[i] - Y[a])) / L;
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return rows.filter((_, i) => keep[i]);
  }

  return { dist, bearing, turn, densify, simplify, R };
})();

/**
 * RouteStore — the route model, the derived track, and persistence.
 *
 * A route is waypoints plus one leg between each consecutive pair. A leg owns
 * its geometry ([lat, lon, ele|null] rows) and the router's turn hints, so
 * moving a waypoint only re-routes the two legs that touch it. Custom cues
 * are anchored by distance from the start and stay put when the route is
 * edited; turn cues are re-derived from the legs every time.
 */
const RouteStore = (() => {
  const DB_NAME = 'routelab';
  const DB_VERSION = 1;
  const STORE = 'routes';

  function blank(name) {
    return {
      id: null, name: name || 'New route', profile: Settings.get('rlProfile') || 'fastbike',
      waypoints: [], legs: [], cues: [], source: 'plan', created: Date.now(), updated: Date.now(),
    };
  }

  /**
   * Flatten the legs into one track with cumulative distance.
   * Returns typed arrays plus `legStart[k]`, the track index where leg k begins.
   */
  function build(route) {
    const rows = [];
    const legStart = [];
    const hints = [];
    let surface = null;
    for (let k = 0; k < route.legs.length; k++) {
      const c = route.legs[k].coords || [];
      // Each leg starts where the previous one ended; drop the duplicate join.
      const skip = rows.length && c.length ? 1 : 0;
      const base = rows.length - skip;
      legStart.push(Math.max(0, base));
      for (let i = skip; i < c.length; i++) rows.push(c[i]);
      const sf = route.legs[k].surface;
      if (sf) {
        surface = surface || { paved: 0, gravel: 0, trail: 0, unknown: 0, maxScale: null };
        for (const key of ['paved', 'gravel', 'trail', 'unknown']) surface[key] += sf[key] || 0;
        if (sf.maxScale != null && (surface.maxScale == null || scaleRank(sf.maxScale) > scaleRank(surface.maxScale))) surface.maxScale = sf.maxScale;
      } else if (route.legs[k].kind !== 'pending' && surface) {
        surface.unknown += legLength(c);
      } else if (route.legs[k].kind !== 'pending') {
        surface = { paved: 0, gravel: 0, trail: 0, unknown: legLength(c), maxScale: null, partial: true };
      }
      for (const h of route.legs[k].hints || []) {
        if (h[0] > 0 && h[0] < c.length) hints.push({ i: base + h[0], cmd: h[1], exit: h[2], angle: h[4], leg: k });
      }
    }
    if (!rows.length && route.waypoints.length === 1) {
      const w = route.waypoints[0];
      rows.push([w.lat, w.lon, null]);
    }
    const n = rows.length;
    const lat = new Float64Array(n), lon = new Float64Array(n), ele = new Float64Array(n), d = new Float64Array(n);
    let eleCount = 0;
    for (let i = 0; i < n; i++) {
      lat[i] = rows[i][0]; lon[i] = rows[i][1];
      const e = rows[i][2];
      ele[i] = e == null || !isFinite(e) ? NaN : e;
      if (!isNaN(ele[i])) eleCount++;
      if (i) d[i] = d[i - 1] + Geo.dist(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    }
    fillGaps(ele);
    smooth(ele, d, 50);
    // Only worth showing when the router told us about at least some of it.
    if (surface && surface.paved + surface.gravel + surface.trail === 0) surface = null;
    const t = { n, lat, lon, ele, d, legStart, hints, surface, dirt: dirtSpans(route, legStart, d, n), length: n ? d[n - 1] : 0, hasEle: n > 1 && eleCount / n > 0.5 };
    Object.assign(t, climbStats(t));
    return t;
  }

  /**
   * Where along the track it is unpaved: [{ fromM, toM, kind: 'gravel'|'trail' }],
   * from each leg's surface runs, stretched to the leg's length here (BRouter's
   * metres and ours differ by a hair).
   */
  function dirtSpans(route, legStart, d, n) {
    const out = [];
    for (let k = 0; k < route.legs.length; k++) {
      const runs = route.legs[k].surface && route.legs[k].surface.runs;
      if (!Array.isArray(runs) || !runs.length) continue;
      const a = legStart[k], b = k + 1 < legStart.length ? legStart[k + 1] : n - 1;
      if (!(b > a)) continue;
      const total = runs.reduce((sum, r) => sum + r[1], 0);
      if (!(total > 0)) continue;
      const scale = (d[b] - d[a]) / total;
      let at = d[a];
      for (const [kind, m] of runs) {
        const to = at + m * scale;
        const name = kind === 'g' ? 'gravel' : kind === 't' ? 'trail' : null;
        if (name) {
          const prev = out[out.length - 1];
          if (prev && prev.kind === name && at - prev.toM < 1) prev.toM = to;
          else out.push({ fromM: at, toM: to, kind: name });
        }
        at = to;
      }
    }
    return out;
  }

  const SCALES = ['0-', '0', '0+', '1-', '1', '1+', '2-', '2', '2+', '3', '4', '5', '6'];
  function scaleRank(s) { return SCALES.indexOf(s); }

  function legLength(c) {
    let m = 0;
    for (let i = 1; i < c.length; i++) m += Geo.dist(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    return m;
  }

  /**
   * Distance-weighted running mean over ±`half` metres, in place. DEM
   * elevations step at tile edges and spike at bridges and cuttings; left
   * alone they invent 30% ramps and a few hundred metres of climbing.
   */
  function smooth(e, d, half) {
    const n = e.length;
    if (n < 3) return;
    // A median first: a mean only spreads a spike out, a median removes it.
    const src = new Float64Array(n);
    let a = 0, b = 0;
    const win = [];
    for (let i = 0; i < n; i++) {
      while (d[i] - d[a] > half) a++;
      while (b < n - 1 && d[b + 1] - d[i] <= half) b++;
      win.length = 0;
      for (let k = a; k <= b; k++) win.push(e[k]);
      win.sort((x, y) => x - y);
      src[i] = win[win.length >> 1];
    }
    // Prefix sums of elevation × segment length, so each window is O(1).
    const P = new Float64Array(n), W = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const w = d[i] - d[i - 1];
      P[i] = P[i - 1] + w * (src[i] + src[i - 1]) / 2;
      W[i] = W[i - 1] + w;
    }
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (d[i] - d[lo] > half) lo++;
      while (hi < n - 1 && d[hi + 1] - d[i] <= half) hi++;
      const w = W[hi] - W[lo];
      e[i] = w > 0 ? (P[hi] - P[lo]) / w : src[i];
    }
  }

  function fillGaps(a) {
    let last = -1;
    for (let i = 0; i < a.length; i++) {
      if (isNaN(a[i])) continue;
      if (last < 0) for (let j = 0; j < i; j++) a[j] = a[i];
      else for (let j = last + 1; j < i; j++) a[j] = a[last] + (a[i] - a[last]) * (j - last) / (i - last);
      last = i;
    }
    if (last >= 0) for (let j = last + 1; j < a.length; j++) a[j] = a[last];
  }

  /** Ascent with a 3 m hysteresis, so DEM noise on the flat doesn't add up to a mountain. */
  function climbStats(t) {
    let up = 0, down = 0, ref = NaN, maxGrade = 0, minE = Infinity, maxE = -Infinity;
    if (!t.hasEle) return { ascent: 0, descent: 0, maxGrade: 0, minEle: NaN, maxEle: NaN };
    for (let i = 0; i < t.n; i++) {
      const e = t.ele[i];
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (isNaN(ref)) { ref = e; continue; }
      if (e - ref >= 3) { up += e - ref; ref = e; }
      else if (ref - e >= 3) { down += ref - e; ref = e; }
    }
    // Steepest 200 m, not steepest pair of DEM samples: even smoothed, a DEM
    // dips into the gorge under a dam or a bridge and climbs out of it at 30%.
    let j = 0;
    for (let i = 0; i < t.n; i++) {
      while (j < t.n - 1 && t.d[j] - t.d[i] < 200) j++;
      if (t.d[j] - t.d[i] >= 200) maxGrade = Math.max(maxGrade, (t.ele[j] - t.ele[i]) / (t.d[j] - t.d[i]));
    }
    return { ascent: up, descent: down, maxGrade, minEle: minE, maxEle: maxE };
  }

  /** Where along the track `atM` metres falls: interpolated position and the segment. */
  function positionAt(t, atM) {
    if (!t.n) return null;
    if (atM <= 0) return { lat: t.lat[0], lon: t.lon[0], ele: t.ele[0], i: 0, f: 0, d: 0 };
    if (atM >= t.length) {
      const k = t.n - 1;
      return { lat: t.lat[k], lon: t.lon[k], ele: t.ele[k], i: Math.max(0, k - 1), f: 1, d: t.length };
    }
    let lo = 0, hi = t.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t.d[m] <= atM) lo = m; else hi = m; }
    const span = t.d[hi] - t.d[lo];
    const f = span > 0 ? (atM - t.d[lo]) / span : 0;
    return {
      lat: t.lat[lo] + (t.lat[hi] - t.lat[lo]) * f,
      lon: t.lon[lo] + (t.lon[hi] - t.lon[lo]) * f,
      ele: t.ele[lo] + (t.ele[hi] - t.ele[lo]) * f,
      i: lo, f, d: atM,
    };
  }

  /** The track index nearest a point, by planar distance in a local projection. */
  function nearest(t, lat, lon) {
    let best = Infinity, bi = -1;
    const k = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < t.n; i++) {
      const dy = t.lat[i] - lat, dx = (t.lon[i] - lon) * k;
      const q = dx * dx + dy * dy;
      if (q < best) { best = q; bi = i; }
    }
    return bi;
  }

  /** Which leg a track index belongs to. */
  function legOf(t, i) {
    let k = 0;
    while (k + 1 < t.legStart.length && t.legStart[k + 1] <= i) k++;
    return k;
  }

  // ── Persistence (IndexedDB) ───────────────────────────────────────────────

  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!self.indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updated', 'updated');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open IndexedDB.'));
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  function makeId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  async function put(route) {
    if (!route.id) route.id = makeId();
    route.updated = Date.now();
    await tx('readwrite', s => s.put(toPlain(route)));
    return route.id;
  }

  async function list() {
    const rows = await tx('readonly', s => s.getAll());
    const all = Array.isArray(rows) ? rows : [];
    all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return all;
  }

  async function get(id) { return tx('readonly', s => s.get(id)); }
  async function remove(id) { return tx('readwrite', s => s.delete(id)); }
  async function clear() { return tx('readwrite', s => s.clear()); }

  function toPlain(route) { return JSON.parse(JSON.stringify(route)); }

  /** A route as JSON another RouteLab can load back, cues and all. */
  function exportJson(route) {
    const out = toPlain(route);
    out.format = 'routelab-route-1';
    return out;
  }

  function fromJson(json) {
    if (!json || !Array.isArray(json.waypoints) || !Array.isArray(json.legs)) return null;
    const r = blank(json.name);
    Object.assign(r, {
      name: json.name || r.name, profile: json.profile || r.profile,
      waypoints: json.waypoints.map(w => ({ lat: +w.lat, lon: +w.lon })),
      legs: json.legs.map(l => Object.assign({ coords: l.coords || [], hints: l.hints || [], kind: l.kind || 'route' }, l.surface ? { surface: l.surface } : {})),
      cues: Array.isArray(json.cues) ? json.cues : [],
      source: json.source || 'json',
    });
    if (r.legs.length !== Math.max(0, r.waypoints.length - 1)) return null;
    return r;
  }

  // ── Links ───────────────────────────────────────────────────────────────
  //
  // A route in a URL fragment (#r=…), so it never reaches a server: the name,
  // terrain, waypoints, your own cues, and the exact line of any imported
  // track. Routed legs are not in it; the link's opener routes them again
  // with the same terrain, which gives the same line unless OpenStreetMap
  // has changed there since. Compact JSON, deflated where the browser can
  // ("z"), else plain ("j"), then base64url.

  /** Google's polyline encoding, generalised to `dims` columns each at its own scale. */
  function encodeLine(rows, scales) {
    let out = '';
    const prev = scales.map(() => 0);
    for (const r of rows) {
      scales.forEach((sc, k) => {
        const v = Math.round((r[k] == null || !isFinite(r[k]) ? 0 : r[k]) * sc);
        let x = v - prev[k];
        prev[k] = v;
        x = x < 0 ? ~(x << 1) : x << 1;
        while (x >= 0x20) { out += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
        out += String.fromCharCode(x + 63);
      });
    }
    return out;
  }
  function decodeLine(str, scales) {
    const rows = [], prev = scales.map(() => 0);
    let i = 0;
    while (i < str.length) {
      const row = [];
      for (let k = 0; k < scales.length; k++) {
        let shift = 0, x = 0, b;
        do { b = str.charCodeAt(i++) - 63; x |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
        prev[k] += x & 1 ? ~(x >> 1) : x >> 1;
        row.push(prev[k] / scales[k]);
      }
      rows.push(row);
    }
    return rows;
  }
  const LATLON = [1e5, 1e5], LATLONELE = [1e5, 1e5, 1];

  function b64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function pipe(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }
  const canDeflate = () => typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined';

  /** The compact object a link carries. */
  function linkData(route) {
    const round = v => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    const tracks = {};
    route.legs.forEach((l, k) => {
      if (l.kind === 'track' && l.coords.length > 1) tracks[k] = encodeLine(Geo.simplify(l.coords, 2), LATLONELE);
    });
    const cues = (route.cues || []).filter(c => !c.auto).map(c => {
      const o = {};
      for (const [k, v] of Object.entries(c)) if (k !== 'id' && v != null && v !== '') o[k] = round(v);
      return o;
    });
    const out = { v: 1, n: route.name, p: route.profile, w: encodeLine(route.waypoints.map(w => [w.lat, w.lon]), LATLON) };
    if (cues.length) out.c = cues;
    if (Object.keys(tracks).length) out.t = tracks;
    return out;
  }

  async function toLink(route) {
    const text = new TextEncoder().encode(JSON.stringify(linkData(route)));
    if (canDeflate()) {
      try { return 'z' + b64url(await pipe(text, new CompressionStream('deflate-raw'))); } catch (_) { /* plain below */ }
    }
    return 'j' + b64url(text);
  }

  /**
   * A link back into a route: legs that were tracks come back exactly, the
   * rest as `pending` for the router. Null if the link is damaged.
   */
  async function fromLink(token) {
    try {
      let bytes = unb64url(token.slice(1));
      if (token[0] === 'z') {
        if (!canDeflate()) return null;
        bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
      } else if (token[0] !== 'j') return null;
      const o = JSON.parse(new TextDecoder().decode(bytes));
      if (!o || o.v !== 1 || typeof o.w !== 'string') return null;
      const wps = decodeLine(o.w, LATLON).map(([lat, lon]) => ({ lat, lon }));
      if (!wps.length || wps.some(w => !(Math.abs(w.lat) <= 90 && Math.abs(w.lon) <= 180))) return null;
      const r = blank(typeof o.n === 'string' ? o.n.slice(0, 200) : 'Shared route');
      r.profile = typeof o.p === 'string' ? o.p : r.profile;
      r.waypoints = wps;
      r.legs = wps.slice(1).map((b, k) => {
        const a = wps[k], t = o.t && o.t[k];
        if (typeof t === 'string') {
          const coords = decodeLine(t, LATLONELE).map(([la, lo, e]) => [la, lo, e]);
          if (coords.length > 1) return { coords, hints: [], kind: 'track' };
        }
        return { coords: [[a.lat, a.lon, null], [b.lat, b.lon, null]], hints: [], kind: 'pending' };
      });
      r.cues = (Array.isArray(o.c) ? o.c : []).filter(c => c && typeof c.type === 'string' && isFinite(c.atM))
        .map((c, k) => ({ ...c, id: 'l' + Date.now().toString(36) + k }));
      r.source = 'link';
      return r;
    } catch (_) {
      return null;
    }
  }

  return {
    blank, build, positionAt, nearest, legOf, fillGaps,
    put, list, get, remove, clear, exportJson, fromJson, toPlain,
    toLink, fromLink, encodeLine, decodeLine,
    DB_NAME, DB_VERSION, STORE,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RouteStore, Settings, Geo, Local };
