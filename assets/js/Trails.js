'use strict';

/**
 * Trails — trail difficulty ratings from OpenStreetMap, for the map overlay
 * and for naming the rated trails a route uses.
 *
 * Two scales are in OSM and both are read:
 *
 *   mtb:scale:imba  the IMBA Trail Difficulty Rating, the trailhead signs:
 *                   0 white circle (easiest), 1 green circle, 2 blue square,
 *                   3 black diamond, 4 double black diamond.
 *   mtb:scale       the S-scale for natural trails, S0–S6.
 *
 * Where a trail has only an S grade, it is drawn in the IMBA colour it most
 * resembles (S0 green … S3 double black, S4+ "pro"), and labelled as an S
 * grade so nobody mistakes it for a sign on the ground.
 *
 * BRouter's lookup table has no mtb:scale:imba, so routing can't use IMBA
 * grades — that is why this comes from Overpass, separately. Overpass is slow
 * (often 20–40 s for an area), so requests go one at a time for z11 tiles
 * (~15 km across), visible tiles first, and are cached in localStorage for
 * 30 days.
 */
const Trails = (() => {
  const Z = 11;
  const MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const MAX_AGE = 30 * 86400e3;

  const RATINGS = {
    white:  { name: 'White circle',         short: 'WHT', color: '#f4f4f4', imba: 0 },
    green:  { name: 'Green circle',         short: 'GRN', color: '#2f9e44', imba: 1 },
    blue:   { name: 'Blue square',          short: 'BLU', color: '#1c6fd6', imba: 2 },
    black:  { name: 'Black diamond',        short: 'BLK', color: '#141414', imba: 3 },
    double: { name: 'Double black diamond', short: 'DBL', color: '#141414', imba: 4 },
    pro:    { name: 'Pro line',             short: 'PRO', color: '#e8590c', imba: 5 },
  };
  const ORDER = ['white', 'green', 'blue', 'black', 'double', 'pro'];
  const IMBA = ['white', 'green', 'blue', 'black', 'double'];

  /** { key, rating, label } for a trail, IMBA first, else from its S grade. */
  function rate(w) {
    if (w.i != null && IMBA[w.i]) {
      const key = IMBA[w.i];
      return { key, rating: RATINGS[key], label: RATINGS[key].name + ' (IMBA ' + w.i + ')' + (w.s != null ? ' · S' + w.s : '') };
    }
    if (w.s != null) {
      const n = parseInt(w.s, 10);
      const key = n <= 0 ? 'green' : n === 1 ? 'blue' : n === 2 ? 'black' : n === 3 ? 'double' : 'pro';
      return { key, rating: RATINGS[key], label: 'S' + w.s + ' (about a ' + RATINGS[key].name.toLowerCase() + ')' };
    }
    return null;
  }

  // ── Tiles ──────────────────────────────────────────────────────────────────

  function tileOf(lat, lon) {
    const n = 1 << Z;
    const la = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n) };
  }
  function boundsOf(x, y) {
    const n = 1 << Z;
    const lat = yy => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * 180 / Math.PI;
    return { s: lat(y + 1), w: x / n * 360 - 180, n: lat(y), e: (x + 1) / n * 360 - 180 };
  }
  function tilesIn(s, w, n, e, max = 30) {
    const a = tileOf(n, w), b = tileOf(s, e), out = [];
    for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) { out.push(x + '/' + y); if (out.length >= max) return out; }
    return out;
  }

  /** Overpass JSON → compact ways: { id, n, i, s, b, g: [lat, lon, lat, lon…] }. */
  function parse(body) {
    const out = [];
    for (const el of (body && body.elements) || []) {
      if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      const t = el.tags || {};
      const imba = t['mtb:scale:imba'] != null ? parseInt(t['mtb:scale:imba'], 10) : null;
      const s = t['mtb:scale'] != null ? String(t['mtb:scale']).trim() : null;
      if ((imba == null || !(imba >= 0 && imba <= 4)) && (s == null || !/^[0-6][+-]?$/.test(s))) continue;
      const g = [];
      for (const p of el.geometry) g.push(Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5);
      out.push({ id: el.id, n: t.name || t.ref || '', i: imba >= 0 && imba <= 4 ? imba : null, s: s && /^[0-6][+-]?$/.test(s) ? s : null,
        b: t.bicycle === 'no' || t.bicycle === 'dismount' ? 1 : 0, g });
    }
    return out;
  }

  // Shared by both layers: the fetch (stubbed in tests) and the retry base.
  let backoffBase = 5000;
  // The public Overpass servers turn requests away when busy ("at capacity…
  // retry using exponential backoff"), so a failed area is retried after 5 s,
  // 10 s, 20 s … up to 5 min, for as long as it is still wanted.
  const backoff = tries => Math.min(300e3, backoffBase * Math.pow(2, Math.max(0, tries - 1)));
  function setBackoff(ms) { backoffBase = ms; }
  let fetchFn = (...a) => fetch(...a);
  function setFetch(fn) { fetchFn = fn; }

  /**
   * One Overpass-backed layer of z11 tiles: a sequential queue, a
   * localStorage cache under `prefix`, and backoff. `query(bbox)` is the
   * Overpass QL body; `parse(json)` makes the compact ways that are cached.
   */
  function layer({ prefix, query, parse, maxTiles }) {
    const PREFIX = prefix, MAX_TILES = maxTiles;
    const tiles = new Map();     // 'x/y' → { ways } once loaded
    const failed = new Map();    // 'x/y' → { at, tries } since the last success
    let viewKeys = [], routeKeys = [];
    let retryTimer = null;
    let queue = [];              // 'x/y' waiting, most wanted first
    let busy = null;             // 'x/y' in flight
    let onChange = () => {};

    function setListener(fn) { onChange = fn || (() => {}); }

    function readCache(key) {
      try {
        const v = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
        if (v && Date.now() - v.t < MAX_AGE && Array.isArray(v.w)) return v.w;
      } catch (_) {}
      return null;
    }
    function writeCache(key, ways) {
      const blob = JSON.stringify({ t: Date.now(), w: ways });
      for (let tries = 0; tries < 4; tries++) {
        try {
          localStorage.setItem(PREFIX + key, blob);
          let idx = [];
          try { idx = JSON.parse(localStorage.getItem(PREFIX + 'index') || '[]'); } catch (_) {}
          idx = idx.filter(k => k !== key).concat(key);
          while (idx.length > MAX_TILES) { try { localStorage.removeItem(PREFIX + idx.shift()); } catch (_) {} }
          localStorage.setItem(PREFIX + 'index', JSON.stringify(idx));
          return;
        } catch (_) {
          // Full: drop the oldest few and try again.
          let idx = [];
          try { idx = JSON.parse(localStorage.getItem(PREFIX + 'index') || '[]'); } catch (_) {}
          if (!idx.length) return;
          for (const k of idx.splice(0, 5)) { try { localStorage.removeItem(PREFIX + k); } catch (_) {} }
          try { localStorage.setItem(PREFIX + 'index', JSON.stringify(idx)); } catch (_) {}
        }
      }
    }
    function clearCache() {
      try {
        const idx = JSON.parse(localStorage.getItem(PREFIX + 'index') || '[]');
        for (const k of idx) localStorage.removeItem(PREFIX + k);
        localStorage.removeItem(PREFIX + 'index');
      } catch (_) {}
      tiles.clear();
      failed.clear();
    }

    /**
     * Ask for tiles, most wanted first. Anything already loaded or cached is
     * served at once; the rest are queued, replacing what was queued before
     * (the map has moved on) unless `keep` is set.
     */
    function want(keys, { keep = false } = {}) {
      if (keep) routeKeys = keys.slice(); else viewKeys = keys.slice();
      let changed = false;
      const missing = [];
      for (const k of keys) {
        if (tiles.has(k) || k === busy) continue;
        const c = readCache(k);
        if (c) { tiles.set(k, { ways: c }); changed = true; continue; }
        const f = failed.get(k);
        if (f && Date.now() - f.at < backoff(f.tries)) continue;
        missing.push(k);
      }
      queue = keep ? queue.concat(missing.filter(k => !queue.includes(k))) : missing.concat(queue.filter(k => !missing.includes(k)).slice(0, 12));
      if (changed) onChange();
      pump();
    }

    async function pump() {
      if (busy || !queue.length) return;
      busy = queue.shift();
      onChange();
      const key = busy;
      try {
        const ways = await load(key);
        tiles.set(key, { ways });
        writeCache(key, ways);
        failed.delete(key);
      } catch (_) {
        const f = failed.get(key) || { tries: 0 };
        failed.set(key, { at: Date.now(), tries: f.tries + 1 });
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { want(routeKeys, { keep: true }); want(viewKeys); }, backoff(f.tries + 1) + 50);
      } finally {
        busy = null;
        onChange();
        pump();
      }
    }

    async function load(key) {
      const [x, y] = key.split('/').map(Number);
      const b = boundsOf(x, y);
      const bb = [b.s, b.w, b.n, b.e].map(v => v.toFixed(5)).join(',');
      const q = query(bb);
      let last = null;
      for (const url of MIRRORS) {
        try {
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const timer = ctl ? setTimeout(() => ctl.abort(), 65000) : null;
          const res = await fetchFn(url, {
            method: 'POST', body: 'data=' + encodeURIComponent(q),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl ? ctl.signal : undefined,
          });
          if (timer) clearTimeout(timer);
          if (!res.ok) { last = new Error('HTTP ' + res.status); continue; }
          return parse(await res.json());
        } catch (err) { last = err; }
      }
      throw last || new Error('Overpass unavailable');
    }

    /** Every loaded way touching a box, each once. */
    function waysIn(s, w, n, e) {
      const seen = new Set(), out = [];
      for (const k of tilesIn(s, w, n, e, 100)) {
        const t = tiles.get(k);
        if (!t) continue;
        for (const way of t.ways) if (!seen.has(way.id)) { seen.add(way.id); out.push(way); }
      }
      return out;
    }

    function status() {
      // Failing = something wanted right now has failed and not yet come back.
      let failing = false, retryIn = 0;
      for (const k of viewKeys.concat(routeKeys)) {
        const f = failed.get(k);
        if (!f || tiles.has(k)) continue;
        failing = true;
        retryIn = Math.max(retryIn, Math.ceil((f.at + backoff(f.tries) - Date.now()) / 1000));
      }
      return { loading: !!busy, queued: queue.length + (busy ? 1 : 0), loaded: tiles.size, failing, retryIn: Math.max(0, retryIn) };
    }

    return { want, waysIn, status, setListener, clearCache, tiles };
  }

  const trailTiles = layer({
    prefix: 'rl-trails-', maxTiles: 60, parse,
    query: bb => '[out:json][timeout:60];(way["mtb:scale"](' + bb + ');way["mtb:scale:imba"](' + bb + '););out tags geom;',
  });

  // ── Dirt roads ─────────────────────────────────────────────────────────────

  // Unpaved surfaces, as in Router's classify(). Driveways (service) are left
  // out: thousands of them in a rural tile, and nobody plans a ride up one.
  const DIRT = 'unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|sand|mud|pebblestone|rock|woodchips';
  const DIRT_ROADS = 'unclassified|residential|tertiary|secondary|road|living_street|cycleway|bridleway';
  const PAVED_TRACK = 'asphalt|concrete|paved|paving_stones|chipseal';

  /**
   * Overpass JSON → compact dirt ways: { id, n, k, g }, where k is
   * 'road' (a road or bike path with an unpaved surface) or 'track'
   * (highway=track, not tracktype=grade1, not surfaced). Trails proper (paths
   * with an mtb:scale) are the ratings layer's business.
   */
  function parseDirt(body) {
    const out = [];
    for (const el of (body && body.elements) || []) {
      if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      const t = el.tags || {};
      let k = null;
      if (t.highway === 'track' && t.tracktype !== 'grade1' && !new RegExp('^(' + PAVED_TRACK + ')$').test(t.surface || '')) k = 'track';
      else if (new RegExp('^(' + DIRT_ROADS + ')$').test(t.highway || '') && new RegExp('^(' + DIRT + ')$').test(t.surface || '')) k = 'road';
      if (!k) continue;
      const g = [];
      for (const p of el.geometry) g.push(Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5);
      out.push({ id: el.id, n: t.name || t.ref || '', k, g });
    }
    return out;
  }

  const dirt = layer({
    prefix: 'rl-dirt-', maxTiles: 24, parse: parseDirt,
    query: bb => '[out:json][timeout:90];(' +
      'way["highway"="track"]["tracktype"!="grade1"]["surface"!~"^(' + PAVED_TRACK + ')$"](' + bb + ');' +
      'way["highway"~"^(' + DIRT_ROADS + ')$"]["surface"~"^(' + DIRT + ')$"](' + bb + ');' +
      ');out tags geom;',
  });

  // ── Matching a route to rated trails ───────────────────────────────────────

  /**
   * Where the route rides a rated trail: [{ fromM, toM, way, r }].
   * A track point is on a trail if a segment of it is within 12 m and runs the
   * same way (either direction) within 35°. Runs shorter than 40 m are noise
   * at a junction; gaps under 30 m inside one trail are closed.
   */
  function match(track) {
    if (!track || track.n < 2) return [];
    let s = 90, n = -90, w = 180, e = -180;
    for (let i = 0; i < track.n; i++) {
      s = Math.min(s, track.lat[i]); n = Math.max(n, track.lat[i]);
      w = Math.min(w, track.lon[i]); e = Math.max(e, track.lon[i]);
    }
    const ways = trailTiles.waysIn(s, w, n, e);
    if (!ways.length) return [];
    // Grid of segments, ~50 m cells, in a local flat projection.
    const lat0 = (s + n) / 2 * Math.PI / 180, R = 6371008.8, kx = Math.cos(lat0) * R * Math.PI / 180, ky = R * Math.PI / 180;
    const X = lon => (lon - w) * kx, Y = lat => (lat - s) * ky;
    const CELL = 50, grid = new Map();
    const segs = [];
    for (const way of ways) {
      for (let k = 0; k + 3 < way.g.length; k += 2) {
        const a = { x: X(way.g[k + 1]), y: Y(way.g[k]) }, b = { x: X(way.g[k + 3]), y: Y(way.g[k + 2]) };
        const id = segs.push({ a, b, way }) - 1;
        const cx0 = Math.floor(Math.min(a.x, b.x) / CELL), cx1 = Math.floor(Math.max(a.x, b.x) / CELL);
        const cy0 = Math.floor(Math.min(a.y, b.y) / CELL), cy1 = Math.floor(Math.max(a.y, b.y) / CELL);
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
          const key = cx + ',' + cy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(id);
        }
      }
    }
    const on = new Array(track.n).fill(null);
    for (let i = 0; i < track.n; i++) {
      const px = X(track.lon[i]), py = Y(track.lat[i]);
      const j = Math.min(track.n - 1, i + 1), h = Math.max(0, i - 1);
      const hx = X(track.lon[j]) - X(track.lon[h]), hy = Y(track.lat[j]) - Y(track.lat[h]);
      const hl = Math.hypot(hx, hy);
      let best = 12, bw = null;
      const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const id of grid.get((cx + dx) + ',' + (cy + dy)) || []) {
          const { a, b, way } = segs[id];
          const sx = b.x - a.x, sy = b.y - a.y, L2 = sx * sx + sy * sy;
          if (!L2) continue;
          const t = Math.max(0, Math.min(1, ((px - a.x) * sx + (py - a.y) * sy) / L2));
          const d = Math.hypot(px - (a.x + t * sx), py - (a.y + t * sy));
          if (d >= best) continue;
          // Right on the line, direction doesn't matter: at a switchback the
          // track's heading is the average of two legs and matches neither.
          if (hl > 0.5 && d > 3) {
            const cos = Math.abs(hx * sx + hy * sy) / (hl * Math.sqrt(L2));
            if (cos < Math.cos(35 * Math.PI / 180)) continue;
          }
          best = d; bw = way;
        }
      }
      on[i] = bw;
    }
    // A run continues while the next on-trail point is the same trail and
    // within 30 m of where the run last was.
    const runs = [];
    let cur = null;
    for (let i = 0; i < track.n; i++) {
      const way = on[i];
      if (!way) continue;
      if (cur && (cur.way.id === way.id || sameTrail(cur.way, way)) && track.d[i] - cur.toM < 30) { cur.toM = track.d[i]; continue; }
      if (cur) runs.push(cur);
      cur = { fromM: track.d[i], toM: track.d[i], way };
    }
    if (cur) runs.push(cur);
    // Pieces of one trail with nothing else between them, less than 200 m apart, are one ride.
    // Slivers under 40 m are a junction brushed in passing; drop them first so
    // they don't split one trail in two.
    const merged = [];
    for (const r of runs.filter(x => x.toM - x.fromM >= 40)) {
      const prev = merged[merged.length - 1];
      if (prev && (prev.way.id === r.way.id || sameTrail(prev.way, r.way)) && r.fromM - prev.toM < 200) prev.toM = r.toM;
      else merged.push({ ...r });
    }
    return merged.filter(r => r.toM - r.fromM >= 40).map(r => ({ ...r, r: rate(r.way) }));
  }

  // OSM splits one trail into many ways; consecutive pieces with the same
  // name and grade read as one trail to the rider.
  function sameTrail(a, b) { return !!a.n && a.n === b.n && a.i === b.i; }

  /** The hardest rating among runs, by IMBA order. */
  function hardest(runs) {
    let best = null;
    for (const r of runs) if (r.r && (!best || ORDER.indexOf(r.r.key) > ORDER.indexOf(best.key))) best = r.r;
    return best ? { key: best.key, ...best.rating } : null;
  }

  return {
    rate, match, hardest, parse, parseDirt, tileOf, boundsOf, tilesIn, setFetch, setBackoff,
    want: trailTiles.want, waysIn: trailTiles.waysIn, status: trailTiles.status,
    setListener: trailTiles.setListener, clearCache: trailTiles.clearCache, tiles: trailTiles.tiles,
    dirt, RATINGS, ORDER, Z,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Trails;
