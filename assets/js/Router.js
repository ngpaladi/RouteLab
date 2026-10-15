'use strict';

/**
 * Router — legs between waypoints, from BRouter.
 *
 * brouter.de is a free public instance with `Access-Control-Allow-Origin: *`,
 * so this runs from the browser with no key. One request per leg, cached by
 * (from, to, profile): dragging a waypoint re-asks for the two legs touching
 * it and nothing else. The geojson it returns carries elevation on every
 * coordinate and the turn "voicehints", so there is no second call for either.
 *
 * Voicehints are [geometryIndex, command, exitNumber, distanceToNext, angle].
 * Command codes are BRouter's VoiceHint constants (brouter-core VoiceHint.java):
 *   1 C   2 TL   3 TSLL   4 TSHL   5 TR   6 TSLR   7 TSHR   8 KL   9 KR
 *  10 TLU 11 TRU 12 OFFR 13 RNDB 14 RNLB 15 TU 16 BL 17 EL 18 ER  100 END
 * Angle is negative for left, positive for right.
 *
 * Straight-line legs (profile 'straight', or the router failing) get their
 * elevation from Open-Meteo's keyless elevation API instead.
 *
 * Terrain. A route's `profile` is one of TERRAIN's keys, not a raw BRouter
 * profile name. Road and gravel are stock BRouter profiles, with URL
 * overrides (`profile:name=value`, which BRouter accepts for any variable a
 * profile assigns). The mountain-bike skill levels need more than an
 * override: BRouter's stock mtb profile prices trails by their OSM
 * `mtb:scale` grade with one fixed table, and ignores `sac_scale`. So each
 * level is that profile (bundled as assets/data/mtb.brf, MIT, from BRouter)
 * with the table rewritten for the rider: grades within the skill are cheap,
 * the top of it costs a little, anything above is 9000 (BRouter's "don't").
 * The rewritten profile is POSTed to brouter.de/brouter/profile, which
 * returns a `custom_…` id to route with. Uploaded profiles don't live
 * forever on the server, so a failed request with one re-uploads once.
 */
const Router = (() => {
  const BROUTER = 'https://brouter.de/brouter';
  const ELEVATION = 'https://api.open-meteo.com/v1/elevation';
  const GEOCODE = 'https://nominatim.openstreetmap.org/search';

  const PROFILE_UPLOAD = 'https://brouter.de/brouter/profile';

  /**
   * Everything the route can follow, easiest to hardest. `crr` is added to
   * the rider's road rolling resistance for the time estimate.
   */
  const TERRAIN = {
    // hint: one line under the picker saying what this level will and won't ride.
    fastbike:       { name: 'Paved roads',              group: 'Road',          brouter: 'fastbike', crr: 0,
      hint: 'Fastest paved roads; stays off dirt.' },
    trekking:       { name: 'Quiet roads & bike paths', group: 'Road',          brouter: 'trekking', crr: 0.002,
      hint: 'Bike paths and quiet roads, including smooth unpaved paths.' },
    gravel:         { name: 'Smooth gravel',            group: 'Gravel',        brouter: 'gravel',   crr: 0.005,
      hint: 'Gravel roads and good tracks where they fit; pavement where it doesn’t.' },
    'gravel-rough': { name: 'Rough gravel & dirt',      group: 'Gravel',        brouter: 'gravel',   crr: 0.008, params: { prefer_unpaved_paths: 1 },
      hint: 'Seeks out unpaved roads, tracks and dirt. Slower, but off the tarmac.' },
    'mtb-1':        { name: 'Beginner · S0–S1',         group: 'Mountain bike', mtb: 1, crr: 0.010,
      hint: 'Smooth singletrack: roots and small rocks at most (S0–S1). No S2 or harder.' },
    'mtb-2':        { name: 'Intermediate · up to S2',  group: 'Mountain bike', mtb: 2, crr: 0.012,
      hint: 'Up to S2: bigger rocks, steps, tight switchbacks. No S3 or alpine trails.' },
    'mtb-3':        { name: 'Advanced · up to S3',      group: 'Mountain bike', mtb: 3, crr: 0.014,
      hint: 'Up to S3: blocky, steep and technical. No S4 or harder.' },
    'mtb-4':        { name: 'Expert · up to S4',        group: 'Mountain bike', mtb: 4, crr: 0.016,
      hint: 'Up to S4: very steep, technical switchbacks. Only S5–S6 are off-limits.' },
    straight:       { name: 'Straight line',            group: 'Other',         crr: 0.002,
      hint: 'Exactly where you click, for trails the router doesn’t know.' },
  };
  // Earlier names, so a saved route keeps working.
  const ALIAS = { mtb: 'mtb-2' };
  function terrain(key) { return TERRAIN[ALIAS[key] || key] || TERRAIN.fastbike; }
  function terrainKey(key) { return TERRAIN[ALIAS[key] || key] ? (ALIAS[key] || key) : 'fastbike'; }
  const PROFILES = Object.fromEntries(Object.entries(TERRAIN).map(([k, v]) => [k, v.name]));

  /**
   * Penalties per OSM grade for each MTB level, added to the cost of a metre.
   * mtb:scale is the difficulty for riding (S0 easy … S5 trials, S6 unridable);
   * sac_scale is the hiking grade, which tags plenty of trails that have no
   * mtb:scale and is a fair proxy for how rocky they are.
   */
  const MTB_LEVELS = {
    1: { scale: { '0': 0, '1-': 0.2, '1': 0.5, '1+': 1.5, '2-': 9000, '2': 9000, '2+': 9000, '3': 9000 },
         sac: { hiking: 0, mountain_hiking: 3 }, factor: 0.5, smooth: 1.0 },
    2: { scale: { '0': 0, '1-': 0, '1': 0, '1+': 0.2, '2-': 0.3, '2': 0.6, '2+': 2.0, '3': 9000 },
         sac: { hiking: 0, mountain_hiking: 0.5 }, factor: 1.0, smooth: 0.7 },
    3: { scale: { '0': 0, '1-': 0, '1': 0, '1+': 0, '2-': 0, '2': 0, '2+': 0.3, '3': 0.8 },
         sac: { hiking: 0, mountain_hiking: 0, demanding_mountain_hiking: 1.0 }, factor: 1.5, smooth: 0.4 },
    4: { scale: { '0': 0, '1-': 0, '1': 0, '1+': 0, '2-': 0, '2': 0, '2+': 0, '3': 0.3, '4': 1.0 },
         sac: { hiking: 0, mountain_hiking: 0, demanding_mountain_hiking: 0.3, alpine_hiking: 2.0 }, factor: 2.0, smooth: 0.25 },
  };

  /** BRouter's mtb profile with the trail-difficulty pricing rewritten for one level. */
  function mtbProfile(template, level) {
    const L = MTB_LEVELS[level];
    if (!L) throw new Error('No MTB level ' + level);
    const block = /  assign mtb_scale_penalty[\s\S]*?else 0\.0\n/;
    if (!block.test(template)) throw new Error('The bundled mtb profile has changed shape; mtb_scale_penalty not found.');
    const cost = v => (v == null ? 9000 : v);
    const scaleRows = ['0-|0|0+', '1-', '1', '1+', '2-', '2', '2+', '3', '4', '5|6'].map(g => {
      const key = g.split('|')[0] === '0-' ? '0' : g.split('|')[0];
      return '  if mtb:scale=' + g + ' then ' + cost(L.scale[key]) + ' else';
    });
    const sacRows = ['hiking', 'mountain_hiking', 'demanding_mountain_hiking', 'alpine_hiking', 'demanding_alpine_hiking', 'difficult_alpine_hiking']
      .map(g => '  if sac_scale=' + g + ' then ' + cost(L.sac[g]) + ' else');
    const replacement =
      '  # RouteLab: MTB level ' + level + '\n' +
      '  assign mtb_scale_penalty  if not consider_smoothness then 0.0 else\n' +
      '  if mtb:scale= then 0.0 else\n' + scaleRows.join('\n') + '\n  0.0\n\n' +
      '  assign sac_scale_penalty\n' +
      '  if sac_scale= then 0.0 else\n' + sacRows.join('\n') + '\n  0.0\n';
    let out = template.replace(block, replacement);
    const rough = 'assign roughness_penalty max smoothness_penalty max mtb_scale_penalty ';
    if (out.indexOf(rough) < 0) throw new Error('The bundled mtb profile has changed shape; roughness_penalty not found.');
    out = out.replace(rough, 'assign roughness_penalty max ( multiply ' + L.smooth + ' smoothness_penalty ) max mtb_scale_penalty max sac_scale_penalty ');
    out = out.replace(/assign   MTB_factor\s+[-\d.]+/, 'assign   MTB_factor             ' + L.factor.toFixed(1));
    // The stock profile allows foot-only ways at a penalty. A trail closed to
    // bikes is not a matter of skill, so forbid them outright.
    out = out.replace(/assign   StrictNOBicycleaccess\s+\d/, 'assign   StrictNOBicycleaccess          1');
    return out;
  }

  let templateUrl = 'assets/data/mtb.brf';
  let templateText = null;
  const uploaded = new Map();   // level → Promise<profile id>

  function setTemplateUrl(u) { templateUrl = u; }

  async function customProfile(level, fresh) {
    if (!fresh && uploaded.has(level)) return uploaded.get(level);
    const p = (async () => {
      if (!templateText) {
        const res = await fetch(templateUrl);
        if (!res.ok) throw new Error('Could not load the MTB routing profile (HTTP ' + res.status + ').');
        templateText = await res.text();
      }
      let res;
      try {
        res = await fetch(PROFILE_UPLOAD, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: mtbProfile(templateText, level) });
      } catch (_) { throw new Error('Could not reach the router (brouter.de). Check your connection.'); }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.profileid) throw new Error('The router rejected the MTB profile' + (body.error ? ': ' + body.error : '.'));
      return body.profileid;
    })();
    uploaded.set(level, p);
    p.catch(() => uploaded.delete(level));
    return p;
  }

  const CMD = {
    1: 'C', 2: 'TL', 3: 'TSLL', 4: 'TSHL', 5: 'TR', 6: 'TSLR', 7: 'TSHR', 8: 'KL', 9: 'KR',
    10: 'TLU', 11: 'TRU', 12: 'OFFR', 13: 'RNDB', 14: 'RNLB', 15: 'TU', 16: 'BL', 17: 'EL', 18: 'ER', 100: 'END',
  };

  const cache = new Map();
  const CACHE_MAX = 200;

  function r6(x) { return Math.round(x * 1e6) / 1e6; }

  function cacheKey(a, b, profile) {
    return [r6(a.lat), r6(a.lon), r6(b.lat), r6(b.lon), terrainKey(profile)].join(',');
  }

  /**
   * Route one leg. Resolves to { coords: [[lat, lon, ele]], hints, kind }.
   * Throws with a readable message when BRouter can't route it.
   */
  async function leg(a, b, profile, { signal } = {}) {
    const T = terrain(profile);
    if (!T.brouter && !T.mtb) return straight(a, b);
    const key = cacheKey(a, b, profile);
    if (cache.has(key)) return clone(cache.get(key));

    const ask = async fresh => {
      const name = T.mtb ? await customProfile(T.mtb, fresh) : T.brouter;
      let q = 'lonlats=' + r6(a.lon) + ',' + r6(a.lat) + '|' + r6(b.lon) + ',' + r6(b.lat) +
        '&profile=' + encodeURIComponent(name) + '&alternativeidx=0&format=geojson&timode=2';
      for (const [k, v] of Object.entries(T.params || {})) q += '&profile:' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
      let res;
      try {
        res = await fetch(BROUTER + '?' + q, { signal });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new Error('Could not reach the router (brouter.de). Check your connection.');
      }
      return { res, body: await res.text() };
    };

    let { res, body } = await ask(false);
    // An uploaded profile can expire on the server; upload it again, once.
    if (T.mtb && (!res.ok || !/^\s*\{/.test(body)) && !/not mapped|no track found/i.test(body)) ({ res, body } = await ask(true));
    if (!res.ok) throw new Error(routerMessage(body, res.status));
    let gj;
    try { gj = JSON.parse(body); } catch (_) { throw new Error(routerMessage(body, res.status)); }
    const out = fromGeoJson(gj);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, out);
    return clone(out);
  }

  function routerMessage(body, status) {
    const t = String(body || '').trim();
    if (/not mapped|position not mapped|no track found|operation killed/i.test(t)) {
      return 'No route between those points — one may be off the road network. Try moving it onto a road, or switch to straight line.';
    }
    if (/datafile .* not found/i.test(t)) return 'The router has no map data for this area.';
    return 'The router could not route this leg' + (status ? ' (HTTP ' + status + ')' : '') + (t ? ': ' + t.slice(0, 120) : '.');
  }

  /** BRouter geojson → our leg shape. Exported for the tests. */
  function fromGeoJson(gj) {
    const f = gj && gj.features && gj.features[0];
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) throw new Error('The router returned no track.');
    const coords = f.geometry.coordinates.map(c => [c[1], c[0], c.length > 2 && isFinite(c[2]) ? c[2] : null]);
    const hints = Array.isArray(f.properties && f.properties.voicehints) ? f.properties.voicehints : [];
    const out = { coords, hints, kind: 'route' };
    const surface = surfaceOf(f.properties && f.properties.messages);
    if (surface) out.surface = surface;
    return out;
  }

  const PAVED = /^(asphalt|concrete|concrete:plates|concrete:lanes|paved|paving_stones|sett|chipseal|metal|wood|unhewn_cobblestone|cobblestone)$/;
  const UNPAVED = /^(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|sand|mud|pebblestone|rock|rocks|woodchips|grass_paver|gravel_turf)$/;
  const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|cycleway|pedestrian)(_link)?$/;
  const TRAILS = /^(path|footway|bridleway|steps)$/;
  const SCALE_ORDER = ['0-', '0', '0+', '1-', '1', '1+', '2-', '2', '2+', '3', '4', '5', '6'];

  /** What one way is, from its OSM tags: 'paved' | 'gravel' | 'trail' | 'unknown'. */
  function classify(tags) {
    const hw = tags.highway || '', sf = tags.surface || '';
    if (tags['mtb:scale'] != null) return 'trail';
    if (PAVED.test(sf)) return 'paved';
    if (TRAILS.test(hw)) return 'trail';
    if (UNPAVED.test(sf)) return 'gravel';
    if (hw === 'track') return tags.tracktype === 'grade1' ? 'paved' : 'gravel';
    if (ROADS.test(hw)) return 'paved';
    return 'unknown';
  }

  /**
   * Metres of each kind of surface on a leg, and the hardest mtb:scale on it,
   * from BRouter's per-way `messages` table (header row first; WayTags is a
   * space-separated "k=v" list).
   */
  function surfaceOf(messages) {
    if (!Array.isArray(messages) || messages.length < 2) return null;
    const head = messages[0];
    const iD = head.indexOf('Distance'), iT = head.indexOf('WayTags');
    if (iD < 0 || iT < 0) return null;
    const out = { paved: 0, gravel: 0, trail: 0, unknown: 0, maxScale: null };
    for (let r = 1; r < messages.length; r++) {
      const d = +messages[r][iD] || 0;
      const tags = {};
      for (const kv of String(messages[r][iT] || '').split(' ')) {
        const eq = kv.indexOf('=');
        if (eq > 0) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      out[classify(tags)] += d;
      const sc = tags['mtb:scale'];
      if (sc != null && SCALE_ORDER.indexOf(sc) > SCALE_ORDER.indexOf(out.maxScale)) out.maxScale = sc;
    }
    return out;
  }

  /** A straight leg, densified so the elevation profile has something to show. */
  async function straight(a, b) {
    const coords = Geo.densify(a, b, 50);
    try { await elevate(coords); } catch (_) { /* flat profile beats no leg */ }
    return { coords, hints: [], kind: 'straight' };
  }

  /** Fill missing elevations in place from Open-Meteo, 100 points per request. */
  async function elevate(rows) {
    const need = [];
    for (let i = 0; i < rows.length; i++) if (rows[i][2] == null) need.push(i);
    for (let s = 0; s < need.length; s += 100) {
      const chunk = need.slice(s, s + 100);
      const q = 'latitude=' + chunk.map(i => rows[i][0].toFixed(5)).join(',') +
        '&longitude=' + chunk.map(i => rows[i][1].toFixed(5)).join(',');
      const res = await fetch(ELEVATION + '?' + q);
      if (!res.ok) throw new Error('Elevation lookup failed (HTTP ' + res.status + ').');
      const body = await res.json();
      const e = body && body.elevation;
      if (!Array.isArray(e)) throw new Error('Elevation lookup returned nothing.');
      chunk.forEach((i, k) => { if (isFinite(e[k])) rows[i][2] = e[k]; });
    }
    return rows;
  }

  /** Place search, for moving the map. Nominatim asks for at most one request a second. */
  async function geocode(q) {
    const res = await fetch(GEOCODE + '?format=jsonv2&limit=5&q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('Search failed (HTTP ' + res.status + ').');
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map(r => ({
      name: r.display_name, lat: +r.lat, lon: +r.lon,
      bbox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null,   // [s, n, w, e]
    }));
  }

  function clone(x) {
    const out = { coords: x.coords.map(c => c.slice()), hints: x.hints.map(h => h.slice()), kind: x.kind };
    if (x.surface) out.surface = { ...x.surface };
    return out;
  }
  function clearCache() { cache.clear(); }

  return {
    leg, straight, elevate, geocode, fromGeoJson, clearCache, setTemplateUrl,
    terrain, terrainKey, mtbProfile, surfaceOf, classify,
    PROFILES, TERRAIN, MTB_LEVELS, CMD, SCALE_ORDER,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Router;
