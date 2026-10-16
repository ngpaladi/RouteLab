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
 * profile name. Every level routes with its own copy of a stock BRouter
 * profile (bundled in assets/data/*.brf, MIT, from BRouter), rewritten here
 * and POSTed to brouter.de/brouter/profile, which returns a `custom_…` id to
 * route with. The rewrites:
 *
 *   · all levels — never a sidewalk (footway=sidewalk), a footway crossing
 *     without bike access, or anything tagged bicycle=no. Cost 10000 is
 *     BRouter's "impassable", which also stops it attaching a clicked point
 *     to the sidewalk beside the road you clicked.
 *   · gravel — a main road with a bike lane costs about what a residential
 *     street does. Stock gravel prices Beacon Street (secondary, lanes both
 *     ways) at nearly twice a back street, so it zig-zags round it.
 *   · MTB levels — the mtb:scale table rewritten per skill level, a
 *     sac_scale penalty added, foot-only ways forbidden.
 *
 * Uploaded profiles don't live forever on the server, so a failed request
 * with one re-uploads once. If the upload itself fails, the leg is routed with
 * the stock profile and marked `fallback`, so the app can say so.
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
    fastbike:       { name: 'Paved roads',              group: 'Road',          template: 'fastbike', crr: 0,
      hint: 'Fastest paved roads; stays off dirt.' },
    trekking:       { name: 'Quiet roads & bike paths', group: 'Road',          template: 'trekking', crr: 0.002,
      hint: 'Bike paths and quiet roads, including smooth unpaved paths.' },
    gravel:         { name: 'Smooth gravel',            group: 'Gravel',        template: 'gravel',   crr: 0.005, lanes: true,
      hint: 'Gravel roads and good tracks where they fit; pavement (bike lanes welcome) where they don’t.' },
    'gravel-rough': { name: 'Rough gravel & dirt',      group: 'Gravel',        template: 'gravel',   crr: 0.008, lanes: true, params: { prefer_unpaved_paths: true },
      hint: 'Seeks out unpaved roads, tracks and dirt. Slower, but off the tarmac.' },
    'mtb-1':        { name: 'Beginner · S0–S1',         group: 'Mountain bike', template: 'mtb', mtb: 1, crr: 0.010,
      hint: 'Smooth singletrack: roots and small rocks at most (S0–S1). No S2 or harder.' },
    'mtb-2':        { name: 'Intermediate · up to S2',  group: 'Mountain bike', template: 'mtb', mtb: 2, crr: 0.012,
      hint: 'Up to S2: bigger rocks, steps, tight switchbacks. No S3 or alpine trails.' },
    'mtb-3':        { name: 'Advanced · up to S3',      group: 'Mountain bike', template: 'mtb', mtb: 3, crr: 0.014,
      hint: 'Up to S3: blocky, steep and technical. No S4 or harder.' },
    'mtb-4':        { name: 'Expert · up to S4',        group: 'Mountain bike', template: 'mtb', mtb: 4, crr: 0.016,
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

  /** Never a sidewalk: appended to the way context of every profile. */
  function noSidewalks(text) {
    const at = text.indexOf('---context:node');
    if (at < 0) throw new Error('A bundled routing profile has changed shape; no node context.');
    const rule =
      '# RouteLab: never a sidewalk, a footway crossing without bike access, or a way closed to bikes.\n' +
      'assign rl_never or footway=sidewalk or bicycle=no and footway=crossing not bicycle=yes|designated|permissive\n' +
      'assign costfactor switch rl_never 10000 costfactor\n\n';
    return text.slice(0, at) + rule + text.slice(at);
  }

  /** Gravel: a main road with a bike lane is priced like a residential street. */
  function bikeLanes(text) {
    // Three places price a main road: its base cost, a 1.8× "no maxspeed tag"
    // penalty on primary/secondary, and a 400 charge for joining one. With a
    // lane, all three go: slightly under a residential street (2.2), because
    // the main road is usually the direct line.
    const rows = [
      [/(switch +highway=primary\|primary_link +)4\.8/, '$1switch any_cycleway 2.0 4.8'],
      [/(switch +highway=secondary\|secondary_link +)4\.2/, '$1switch any_cycleway 1.9 4.2'],
      [/(switch +highway=tertiary\|tertiary_link +)3\.6/, '$1switch any_cycleway 1.9 3.6'],
      [/switch highway=primary\|secondary 1\.8 1\.0/, 'switch and highway=primary|secondary not any_cycleway 1.8 1.0'],
      [/switch is_main_road 400/, 'switch and is_main_road not any_cycleway 400'],
    ];
    for (const [re, to] of rows) {
      if (!re.test(text)) throw new Error('The bundled gravel profile has changed shape; main-road costs not found.');
      text = text.replace(re, to);
    }
    return text;
  }

  /** Bake `profile:` overrides into the text rather than trusting URL overrides on a custom profile. */
  function withParams(text, params) {
    for (const [k, v] of Object.entries(params || {})) {
      const re = new RegExp('(assign\\s+' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=?\\s*)\\S+');
      if (!re.test(text)) throw new Error('The routing profile has no ' + k + '.');
      text = text.replace(re, '$1' + v);
    }
    return text;
  }

  /** The full profile text a terrain level routes with. */
  function profileText(template, key) {
    const T = terrain(key);
    let out = T.mtb ? mtbProfile(template, T.mtb) : template;
    if (T.lanes) out = bikeLanes(out);
    out = withParams(out, T.params);
    return noSidewalks(out);
  }

  let templateBase = 'assets/data/';
  const templates = new Map();  // name → Promise<text>
  const uploaded = new Map();   // terrain key → Promise<profile id>

  function setTemplateBase(u) { templateBase = u.replace(/[^/]*$/, ''); }

  function templateFor(name) {
    if (!templates.has(name)) {
      const p = fetch(templateBase + name + '.brf').then(res => {
        if (!res.ok) throw new Error('Could not load the ' + name + ' routing profile (HTTP ' + res.status + ').');
        return res.text();
      });
      templates.set(name, p);
      p.catch(() => templates.delete(name));
    }
    return templates.get(name);
  }

  async function customProfile(key, fresh) {
    if (!fresh && uploaded.has(key)) return uploaded.get(key);
    const T = terrain(key);
    const p = (async () => {
      const text = profileText(await templateFor(T.template), key);
      let res;
      try {
        res = await fetch(PROFILE_UPLOAD, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
      } catch (_) { throw new Error('Could not reach the router (brouter.de). Check your connection.'); }
      const body = await res.json().catch(() => ({}));
      // brouter.de answers a profile that fails to parse with an id *and* an
      // error; routing with that id fails later and less clearly.
      if (!res.ok || !body.profileid || body.error) throw new Error('The router rejected the profile' + (body.error ? ': ' + body.error : '.'));
      return body.profileid;
    })();
    uploaded.set(key, p);
    p.catch(() => uploaded.delete(key));
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
    if (!T.template) return straight(a, b);
    const key = cacheKey(a, b, profile);
    if (cache.has(key)) return clone(cache.get(key));

    let fallback = false;
    const ask = async fresh => {
      let name, extra = '';
      try {
        name = await customProfile(terrainKey(profile), fresh);
      } catch (err) {
        // Route anyway with the stock profile, and say so.
        fallback = true;
        name = T.template;
        for (const [k, v] of Object.entries(T.params || {})) extra += '&profile:' + encodeURIComponent(k) + '=' + (v === true ? 1 : v === false ? 0 : encodeURIComponent(v));
      }
      const q = 'lonlats=' + r6(a.lon) + ',' + r6(a.lat) + '|' + r6(b.lon) + ',' + r6(b.lat) +
        '&profile=' + encodeURIComponent(name) + '&alternativeidx=0&format=geojson&timode=2' + extra;
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
    if (!fallback && (!res.ok || !/^\s*\{/.test(body)) && !/not mapped|no track found/i.test(body)) ({ res, body } = await ask(true));
    if (!res.ok) throw new Error(routerMessage(body, res.status));
    let gj;
    try { gj = JSON.parse(body); } catch (_) { throw new Error(routerMessage(body, res.status)); }
    const out = fromGeoJson(gj);
    if (fallback) out.fallback = true;
    else {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, out);
    }
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
    if (x.fallback) out.fallback = true;
    return out;
  }
  function clearCache() { cache.clear(); }

  return {
    leg, straight, elevate, geocode, fromGeoJson, clearCache, setTemplateBase,
    terrain, terrainKey, mtbProfile, profileText, noSidewalks, bikeLanes, surfaceOf, classify,
    PROFILES, TERRAIN, MTB_LEVELS, CMD, SCALE_ORDER,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Router;
