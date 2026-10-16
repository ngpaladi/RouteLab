'use strict';

/**
 * Headless tests. Loads the real browser modules into a shared context (they
 * are plain scripts, not ES modules) and exercises them on the sample route,
 * a real BRouter result: track building, turn cues, cue series, power
 * targets, timing, climbs, and the GPX/TCX writers — checked by reading the
 * files back.
 *
 *   node test/harness.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'assets', 'js');

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    key: i => Array.from(m.keys())[i],
    get length() { return m.size; },
  };
}

const sandbox = {
  console, localStorage: memStorage(), sessionStorage: memStorage(), self: {}, indexedDB: null,
  fetch: () => Promise.reject(new Error('network disabled in tests')),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  Math, JSON, Date, Number, String, Array, Object, Boolean, Error, Map, Set, Promise, RegExp,
  Float64Array, Int32Array, Uint8Array, ArrayBuffer, DataView, isFinite, isNaN, parseFloat, parseInt,
  URLSearchParams, encodeURIComponent, setTimeout, clearTimeout,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['Intervals.js', 'RouteStore.js', 'Router.js', 'Cues.js', 'Gpx.js', 'Trails.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8') + '\n;globalThis.__last = true;', sandbox, { filename: f });
}
const G = name => vm.runInContext(name, sandbox);
const RouteStore = G('RouteStore'), Geo = G('Geo');
const Router = G('Router'), Cues = G('Cues'), Gpx = G('Gpx'), Units = G('Units'), Trails = G('Trails');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── Sample route ───────────────────────────────────────────────────────────

section('Track from the sample route');
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data', 'sample-route.json'), 'utf8'));
const route = RouteStore.fromJson({ ...sample, legs: sample.legs.map(l => ({ ...l, kind: 'route' })) });
check('sample parses as a route', !!route && route.waypoints.length === 8 && route.legs.length === 7);
const t = RouteStore.build(route);
check('length matches BRouter to 0.5%', near(t.length, 69480, 69480 * 0.005), Math.round(t.length) + ' m');
check('one join per leg is dropped', t.n === sample.legs.reduce((s, l) => s + l.coords.length, 0) - 6, String(t.n));
check('legStart has one entry per leg', t.legStart.length === 7 && t.legStart[0] === 0);
check('distance is non-decreasing', Array.from(t.d).every((x, i) => i === 0 || x >= t.d[i - 1]));
check('has elevation', t.hasEle && t.maxEle > 400 && t.minEle < 20, Math.round(t.minEle) + '–' + Math.round(t.maxEle) + ' m');
check('ascent is sane for the Alpine Dam loop', t.ascent > 1000 && t.ascent < 2200, Math.round(t.ascent) + ' m');
check('ascent ≈ descent on a loop', near(t.ascent, t.descent, 60));
// SRTM reads switchbacks cut into a steep hillside steeper than they ride, so
// this only guards against raw DEM spikes (which gave 30% over 100 m).
check('steepest 200 m is plausible', t.maxGrade > 0.06 && t.maxGrade < 0.25, (t.maxGrade * 100).toFixed(1) + '%');

const mid = RouteStore.positionAt(t, 30000);
check('positionAt interpolates', near(mid.d, 30000, 1e-6) && t.d[mid.i] <= 30000 && t.d[mid.i + 1] >= 30000);
check('positionAt clamps to the ends', RouteStore.positionAt(t, -5).i === 0 && RouteStore.positionAt(t, 1e9).d === t.length);
check('nearest finds a track point', RouteStore.nearest(t, t.lat[500], t.lon[500]) === 500);
const loopRows = Array.from({ length: 400 }, (_, i) => { const a = i / 399 * 2 * Math.PI; return [51.5 + 0.01 * Math.sin(a), -0.1 + 0.016 * (1 - Math.cos(a)), null]; });
const simp = Geo.simplify(loopRows, 2);
check('simplify keeps a closed loop', simp.length > 20 && simp.length < 400, simp.length + ' of 400');
check('legOf maps indices to legs', RouteStore.legOf(t, 0) === 0 && RouteStore.legOf(t, t.n - 1) === 6 && RouteStore.legOf(t, t.legStart[3]) === 3);

section('Turn cues from BRouter hints');
// The hint index has to be the geometry index: check the road really turns that way there.
let agree = 0, total = 0;
for (const h of t.hints) {
  const c = Router.CMD[h.cmd];
  if (!/^(TL|TR|TSHL|TSHR)$/.test(c)) continue;
  const a = RouteStore.positionAt(t, t.d[h.i] - 25), b = RouteStore.positionAt(t, t.d[h.i] + 25);
  const turn = Geo.turn(Geo.bearing(a.lat, a.lon, t.lat[h.i], t.lon[h.i]), Geo.bearing(t.lat[h.i], t.lon[h.i], b.lat, b.lon));
  total++;
  if (Math.sign(turn) === (/L$/.test(c) ? -1 : 1)) agree++;
}
check('hint index is the geometry index (turns go the way the hint says)', total >= 5 && agree / total >= 0.85, agree + '/' + total);
const turns = Cues.turns(t);
const slightAlso = Cues.turns(t, { slight: true });
check('turn cues produced', turns.length >= 10, turns.length + ' turns');
check('slight turns only when asked', slightAlso.length > turns.length, turns.length + ' → ' + slightAlso.length);
check('turn cues are left/right/generic', turns.every(c => ['left', 'right', 'generic'].includes(c.type)));
check('turn cues sit at their hint distance', turns.every(c => c.atM > 0 && c.atM < t.length));

section('Custom cues');
const eat = Cues.series('eat', { everyM: 20000, fromM: 15000, toM: t.length, label: 'Eat' });
check('series count', eat.length === Math.floor((t.length - 15000) / 20000) + 1, eat.length + ' cues');
check('series spacing', eat.every((c, i) => near(c.atM, 15000 + 20000 * i, 1e-6)));
check('series share an id', new Set(eat.map(c => c.series)).size === 1 && eat.every(c => c.series));
check('series ids are unique per cue', new Set(eat.map(c => c.id)).size === eat.length);
let threw = false; try { Cues.series('eat', { everyM: 0, fromM: 0, toM: 100 }); } catch (_) { threw = true; }
check('a zero interval is refused', threw);
const pw = Cues.power(20000, 32000, 250, 250);
check('power cue label and note', pw.label === '250 W' && /100% FTP/.test(pw.note) && /12\.0 km/.test(pw.note), pw.note);
check('power short name fits 10 chars', Cues.shortName(pw) === '250W 12km', Cues.shortName(pw));
check('long labels are cut to 10', Cues.shortName(Cues.make('note', 0, { label: 'Refill bottles at the café' })).length <= 10);
check('non-ASCII is dropped from short names', !/[^\x20-\x7e]/.test(Cues.shortName(Cues.make('eat', 0, { label: 'Gel 🍌 now' }))));
route.cues = [...eat, pw, Cues.make('drink', t.length + 5000)];
const all = Cues.all(route, t, { turns: true });
check('all() adds an end cue for a power block', all.some(c => c.isEnd && near(c.atM, 32000, 1e-6)));
check('all() leaves out cues past the end', !all.some(c => c.atM > t.length + 1));
check('stranded() reports them', Cues.stranded(route, t).length === 1);
check('all() is sorted by distance', all.every((c, i) => i === 0 || c.atM >= all[i - 1].atM));

section('Climbs and timing');
const climbs = Cues.climbs(t);
check('finds the climbs', climbs.length >= 2, climbs.map(c => (c.fromM / 1000).toFixed(1) + '–' + (c.toM / 1000).toFixed(1) + ' km ' + (c.grade * 100).toFixed(1) + '%').join(', '));
check('every climb is ≥ 2 km and ≥ 3%', climbs.every(c => c.toM - c.fromM >= 2000 && c.grade >= 0.03));
check('climbs go up', climbs.every(c => c.gain > 60));
const cfg = { mass: 78, cda: 0.32, crr: 0.004, ftp: 250, ridePct: 70, maxDescent: 55 };
route.cues = [];
const times = Cues.timing(route, t, cfg);
const total_h = times[t.n - 1] / 3600;
check('time estimate is plausible for 69 km and 1500 m at 175 W', total_h > 2.3 && total_h < 3.8, total_h.toFixed(2) + ' h');
check('time is non-decreasing', Array.from(times).every((x, i) => i === 0 || x >= times[i - 1]));
const c0 = climbs[0];
route.cues = [Cues.power(c0.fromM, c0.toM, 300, 250)];
const faster = Cues.timing(route, t, cfg);
const span = (T, a, b) => Cues.timeAt(t, T, b) - Cues.timeAt(t, T, a);
check('a higher power target makes that climb faster', span(faster, c0.fromM, c0.toM) < span(times, c0.fromM, c0.toM) * 0.9,
  Units.duration(span(times, c0.fromM, c0.toM)) + ' → ' + Units.duration(span(faster, c0.fromM, c0.toM)));
check('…and leaves the rest alone', near(span(faster, 0, c0.fromM), span(times, 0, c0.fromM), 1));
const flatRoute = { ...route, profile: 'fastbike', cues: [] }, mtbRoute = { ...route, profile: 'mtb-3', cues: [] };
check('rougher terrain is slower', Cues.timing(mtbRoute, t, cfg)[t.n - 1] > Cues.timing(flatRoute, t, cfg)[t.n - 1] * 1.05);

// ── Export ─────────────────────────────────────────────────────────────────

section('Cue points on the track');
route.cues = [...eat, Cues.power(c0.fromM, c0.toM, 260, 250), Cues.make('danger', t.d[100]), Cues.make('note', t.d[200] + 0.4)];
const cues = Cues.all(route, t, { turns: true });
const { pts, at } = Gpx.withCuePoints(t, cues);
check('every cue has a point', cues.every(c => at.has(c.id)), at.size + '/' + cues.length);
check('each cue point is at the cue distance', cues.every(c => near(pts[at.get(c.id)].d, c.atM, 1)));
check('distance stays monotonic after inserting', pts.every((p, i) => i === 0 || p.d >= pts[i - 1].d - 1e-6));
check('cues on or within 1 m of a point snap to it', !pts.some(p => p.cue && (Math.abs(p.d - t.d[100]) < 1e-6 || Math.abs(p.d - (t.d[200] + 0.4)) < 1e-6)));
check('only off-vertex cues add points', pts.length - t.n === cues.filter(c => {
  const p = RouteStore.positionAt(t, c.atM);
  return Math.abs(t.d[p.i] - p.d) >= 1 && Math.abs(t.d[Math.min(p.i + 1, t.n - 1)] - p.d) >= 1;
}).length, '+' + (pts.length - t.n));

section('GPX');
const gpx = Gpx.toGpx({ ...route, name: 'Test & "loop"' }, t, cues);
const back = Gpx.parse(gpx);
check('GPX reads back with every point', back.rows.length === pts.length, back.rows.length + ' points');
check('GPX reads back every cue', back.marks.length === cues.length, back.marks.length + ' waypoints');
const trk = new Set(gpx.match(/<trkpt lat="[^"]+" lon="[^"]+"/g).map(s => s.replace('trkpt', 'X')));
const wpts = gpx.match(/<wpt lat="[^"]+" lon="[^"]+"/g).map(s => s.replace('wpt', 'X'));
check('every <wpt> is exactly a <trkpt>', wpts.every(w => trk.has(w)));
check('<wpt> come before <trk> (GPX 1.1 order)', gpx.indexOf('<wpt') < gpx.indexOf('<trk>'));
check('names are short', back.marks.every(m => m.name.length <= 10));
check('XML special characters are escaped', /Test &amp; &quot;loop&quot;/.test(gpx) && back.name === 'Test & "loop"');
check('types are Garmin course-point types', back.marks.every(m => /^(Generic|Summit|Valley|Water|Food|Danger|Left|Right|Straight|First Aid)$/.test(m.type)));
check('eat cues are Food', back.marks.filter(m => m.type === 'Food').length === eat.length);
check('elevation is written', /<trkpt[^>]+><ele>/.test(gpx));
check('cueType maps types back', Gpx.cueType({ type: 'Food', name: 'Eat' }) === 'eat' && Gpx.cueType({ type: 'Water', name: '' }) === 'drink' && Gpx.cueType({ type: 'Left', name: '' }) === 'left');

section('TCX');
const tcx = Gpx.toTcx({ ...route, name: 'A very long course name indeed' }, t, cues, Cues.timing(route, t, cfg));
const cps = tcx.match(/<CoursePoint>[\s\S]*?<\/CoursePoint>/g) || [];
check('one CoursePoint per cue', cps.length === cues.length, String(cps.length));
check('CoursePoint names are 1–10 characters', cps.every(c => { const n = /<Name>([^<]*)<\/Name>/.exec(c)[1]; return n.length >= 1 && n.length <= 10; }));
check('CoursePoint element order follows the schema', cps.every(c => /^<CoursePoint><Name>.*<\/Name><Time>.*<\/Time><Position>.*<\/Position>(<AltitudeMeters>.*<\/AltitudeMeters>)?<PointType>.*<\/PointType><Notes>.*<\/Notes><\/CoursePoint>$/.test(c)));
check('PointType is from the TCX enumeration', cps.every(c => /<PointType>(Generic|Summit|Valley|Water|Food|Danger|Left|Right|Straight|First Aid)<\/PointType>/.test(c)));
check('Course name is cut to 15', /<Name>A very long cou<\/Name>/.test(tcx));
const tps = tcx.match(/<Trackpoint><Time>([^<]+)<\/Time>/g).map(s => Date.parse(s.slice(18, 38)));
check('times are non-decreasing', tps.every((x, i) => i === 0 || x >= tps[i - 1]));
const tback = Gpx.parse(tcx);
check('TCX reads back', tback.rows.length === pts.length && tback.marks.length === cues.length);
const tpCoords = new Set(tcx.match(/<Trackpoint>[\s\S]*?<\/Trackpoint>/g).map(s => /<Position>.*?<\/Position>/.exec(s)[0]));
check('every CoursePoint is exactly a Trackpoint', cps.every(c => tpCoords.has(/<Position>.*?<\/Position>/.exec(c)[0])));

section('Cue sheet');
const csv = Gpx.toCsv(cues, t, times, 'km');
check('one row per cue plus a header', csv.trim().split('\n').length === cues.length + 1);
check('quotes are doubled', /"x ""y"""/.test(Gpx.toCsv([Cues.make('note', 0, { label: 'x "y"' })], t, times, 'km')));

section('Importing other files');
const foreign = `<?xml version="1.0"?><gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="51.5" lon="-0.1"><name>Café stop</name><sym>Restaurant</sym></wpt>
  <rte><name>Only a route</name>
    <rtept lat="51.50" lon="-0.10"><ele>10</ele></rtept>
    <rtept lat="51.51" lon="-0.11"/>
    <rtept lat='51.52' lon='-0.12'><ele>14.5</ele></rtept>
  </rte></gpx>`;
const f = Gpx.parse(foreign);
check('reads <rtept> when there is no track, both quote styles', f.rows.length === 3 && f.rows[2][2] === 14.5);
check('self-closing points have no elevation', f.rows[1][2] === null);
check('waypoint names decode', f.marks[0].name === 'Café stop' && Gpx.cueType(f.marks[0]) === 'eat');
const mixed = '<gpx><trk><name>T</name><trkseg><trkpt lat="1" lon="2"></trkpt><trkpt lat="1.001" lon="2"></trkpt></trkseg></trk><rte><rtept lat="9" lon="9"/></rte></gpx>';
check('a track wins over a route in the same file', Gpx.parse(mixed).rows.length === 2);

section('Terrain and the MTB profile');
const tpl = fs.readFileSync(path.join(ROOT, 'assets', 'data', 'mtb.brf'), 'utf8');
for (const lvl of [1, 2, 3, 4]) {
  const p = Router.mtbProfile(tpl, lvl);
  const ok = /# RouteLab: MTB level/.test(p) && /assign sac_scale_penalty/.test(p) && /max sac_scale_penalty/.test(p) &&
    /StrictNOBicycleaccess +1/.test(p) && !/mtb:scale=3 +then 15\.0/.test(p);
  check('MTB level ' + lvl + ' profile is rewritten', ok);
}
const p1 = Router.mtbProfile(tpl, 1), p4 = Router.mtbProfile(tpl, 4);
check('beginner forbids S2', /mtb:scale=2 then 9000/.test(p1));
check('expert allows S4 and forbids S5', /mtb:scale=4 then 1/.test(p4) && /mtb:scale=5\|6 then 9000/.test(p4));
check('expert accepts alpine hiking trails at a cost; beginner does not', /sac_scale=alpine_hiking then 2/.test(p4) && /sac_scale=alpine_hiking then 9000/.test(p1));
let bad = false; try { Router.mtbProfile('nothing here', 2); } catch (_) { bad = true; }
check('a changed template is refused, not silently ignored', bad);
check('old profile names still resolve', Router.terrainKey('mtb') === 'mtb-2' && Router.terrainKey('nope') === 'fastbike');
check('every terrain has a hint and a group', Object.values(Router.TERRAIN).every(v => v.hint && v.group));

section('Every routed level: no sidewalks; gravel takes bike lanes');
const brf = name => fs.readFileSync(path.join(ROOT, 'assets', 'data', name + '.brf'), 'utf8');
for (const [k, T] of Object.entries(Router.TERRAIN)) {
  if (!T.template) continue;
  const txt = Router.profileText(brf(T.template), k);
  const at = txt.indexOf('assign rl_never'), node = txt.indexOf('---context:node');
  check(k + ': sidewalk ban in the way context', at > 0 && at < node && /assign costfactor switch rl_never 10000 costfactor/.test(txt) && /footway=sidewalk/.test(txt.slice(at, node)));
}
const g = Router.profileText(brf('gravel'), 'gravel');
check('gravel prices laned main roads like a back street', /highway=secondary\|secondary_link +switch any_cycleway 1\.9 3\.0/.test(g) && /highway=primary\|primary_link +switch any_cycleway 2\.0 4\.8/.test(g));
check('…unlaned ones dearer but not double, and no no-maxspeed penalty', /highway=tertiary\|tertiary_link +switch any_cycleway 1\.9 2\.6/.test(g) && !/switch highway=primary\|secondary 1\.8/.test(g));
check('…a small charge to join a main road without a lane', /switch and is_main_road not any_cycleway 100/.test(g) && !/is_main_road 400/.test(g));
check('…and corners cost enough to stop zig-zags', /assign turncost switch junction=roundabout 15 150/.test(g));
check('rough gravel bakes in prefer_unpaved_paths', /assign prefer_unpaved_paths true/.test(Router.profileText(brf('gravel'), 'gravel-rough')) && /assign prefer_unpaved_paths false/.test(g));
check('quiet roads: a turn costs 150, paved roads keep the stock 90', /else 150\n/.test(Router.profileText(brf('trekking'), 'trekking')) && /else 90\n/.test(Router.profileText(brf('fastbike'), 'fastbike')));
check('road profiles are not given the gravel lane rewrite', !/any_cycleway 1\.9/.test(Router.profileText(brf('fastbike'), 'fastbike')));
let shape = false; try { Router.noSidewalks('assign x 1'); } catch (_) { shape = true; }
check('a template without a node context is refused', shape);

const msgs = [
  ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'],
  ['0', '0', '0', '100', '', '', '', '', '', 'highway=residential', '', '', ''],
  ['0', '0', '0', '50', '', '', '', '', '', 'highway=track tracktype=grade3', '', '', ''],
  ['0', '0', '0', '30', '', '', '', '', '', 'highway=path mtb:scale=2', '', '', ''],
  ['0', '0', '0', '20', '', '', '', '', '', 'highway=path surface=asphalt', '', '', ''],
  ['0', '0', '0', '10', '', '', '', '', '', 'highway=path mtb:scale=1+', '', '', ''],
  ['0', '0', '0', '5', '', '', '', '', '', 'man_made=pier', '', '', ''],
];
const sf = Router.surfaceOf(msgs);
check('surface summary sums by kind', sf.paved === 120 && sf.gravel === 50 && sf.trail === 40 && sf.unknown === 5, JSON.stringify(sf));
check('hardest mtb:scale is kept', sf.maxScale === '2');
const withSurface = { ...route, legs: route.legs.map((l, k) => k === 0 ? { ...l, surface: sf } : l) };
const ts = RouteStore.build(withSurface).surface;
check('a leg without a summary counts as unknown in the route total', ts && ts.paved === 120 && ts.unknown > 60000);
check('surface runs in order along the leg', JSON.stringify(sf.runs) === JSON.stringify([['p', 100], ['g', 50], ['t', 30], ['p', 20], ['t', 10], ['u', 5]]), JSON.stringify(sf.runs));
// A 1 km straight leg whose router metres (215) are stretched to its length.
const dirtLeg = { kind: 'route', hints: [], surface: sf, coords: Array.from({ length: 101 }, (_, i) => [45 + i * 0.00009, 7, null]) };
const dirtTrack = RouteStore.build({ name: 'd', waypoints: [{ lat: 45, lon: 7 }, { lat: 45.009, lon: 7 }], legs: [dirtLeg], cues: [] });
const L = dirtTrack.length, sp = dirtTrack.dirt;
check('dirt spans: gravel then trail, scaled to the leg', sp.length === 3 && sp[0].kind === 'gravel' && Math.abs(sp[0].fromM - L * 100 / 215) < 1 && Math.abs(sp[0].toM - L * 150 / 215) < 1 && sp[1].kind === 'trail' && sp[2].kind === 'trail', JSON.stringify(sp));
check('a leg without runs (older save) has no spans', RouteStore.build(route).dirt.length === 0);

section('Trail ratings');
// A straight north-south trail, a crossing east-west one, and junk to ignore.
const overpass = { elements: [
  { type: 'way', id: 1, tags: { highway: 'path', name: 'Flow Line', 'mtb:scale:imba': '2', 'mtb:scale': '1' },
    geometry: [{ lat: 40.000, lon: -105.000 }, { lat: 40.005, lon: -105.000 }, { lat: 40.010, lon: -105.000 }] },
  { type: 'way', id: 2, tags: { highway: 'path', name: 'Rock Garden', 'mtb:scale': '3' },
    geometry: [{ lat: 40.005, lon: -105.004 }, { lat: 40.005, lon: -104.996 }] },
  { type: 'way', id: 3, tags: { highway: 'path', name: 'Hikers Only', 'mtb:scale': '1', bicycle: 'no' },
    geometry: [{ lat: 40.02, lon: -105.01 }, { lat: 40.03, lon: -105.01 }] },
  { type: 'way', id: 4, tags: { highway: 'path', 'mtb:scale': 'difficult' }, geometry: [{ lat: 40, lon: -105 }, { lat: 40.1, lon: -105 }] },
  { type: 'node', id: 5, lat: 40, lon: -105 },
] };
const ways = Trails.parse(overpass);
check('parses rated ways, skips junk grades and nodes', ways.length === 3 && ways.every(w => w.g.length >= 4), ways.map(w => w.id).join(','));
check('IMBA wins over the S grade', Trails.rate(ways[0]).key === 'blue' && /IMBA 2/.test(Trails.rate(ways[0]).label) && /S1/.test(Trails.rate(ways[0]).label));
check('S grade alone maps to the nearest sign, labelled as S', Trails.rate(ways[1]).key === 'double' && /^S3/.test(Trails.rate(ways[1]).label));
check('closed-to-bikes is kept', ways[2].b === 1);
check('S0 green, S2 black, S5 pro', Trails.rate({ s: '0' }).key === 'green' && Trails.rate({ s: '2' }).key === 'black' && Trails.rate({ s: '5' }).key === 'pro');
check('every IMBA grade has a sign', [0, 1, 2, 3, 4].map(i => Trails.rate({ i }).key).join() === 'white,green,blue,black,double');
const tk = Trails.tileOf(40.005, -105.0);
const tb = Trails.boundsOf(tk.x, tk.y);
check('tile bounds contain the point', tb.s < 40.005 && tb.n > 40.005 && tb.w < -105 && tb.e > -105);
Trails.tiles.set(tk.x + '/' + tk.y, { ways });
check('waysIn finds loaded ways', Trails.waysIn(39.99, -105.02, 40.04, -104.99).length === 3);
// A route that rides Flow Line north, crossing Rock Garden at right angles.
const ride = { name: 'r', waypoints: [{ lat: 39.995, lon: -105.0001 }, { lat: 40.012, lon: -105.0001 }],
  legs: [{ kind: 'track', hints: [], coords: Array.from({ length: 171 }, (_, i) => [39.995 + i * 0.0001, -105.0001, 1700]) }], cues: [] };
const rt = RouteStore.build(ride);
const runs = Trails.match(rt);
check('matches the trail the route rides', runs.length === 1 && runs[0].way.id === 1, runs.map(r => r.way.n + ' ' + Math.round(r.fromM) + '–' + Math.round(r.toM)).join(', '));
check('…from where it joins to where it ends', runs[0] && Math.abs(runs[0].fromM - 556) < 25 && Math.abs(runs[0].toM - 1668) < 25);
check('a trail crossed at right angles is not "ridden"', !runs.some(r => r.way.id === 2));
check('hardest of the runs', Trails.hardest(runs).name === 'Blue square');
const far = RouteStore.build({ ...ride, legs: [{ kind: 'track', hints: [], coords: ride.legs[0].coords.map(c => [c[0], c[1] + 0.0003, c[2]]) }] });
check('25 m off to the side is not on the trail', Trails.match(far).length === 0);
Trails.tiles.clear();

const dirtWays = Trails.parseDirt({ elements: [
  { type: 'way', id: 1, tags: { highway: 'track', tracktype: 'grade3' }, geometry: [{ lat: 40, lon: -105 }, { lat: 40.01, lon: -105 }] },
  { type: 'way', id: 2, tags: { highway: 'track', tracktype: 'grade1' }, geometry: [{ lat: 40, lon: -105 }, { lat: 40.01, lon: -105 }] },
  { type: 'way', id: 3, tags: { highway: 'unclassified', surface: 'gravel', name: 'Old Mill Rd' }, geometry: [{ lat: 40, lon: -105 }, { lat: 40.01, lon: -105 }] },
  { type: 'way', id: 4, tags: { highway: 'residential', surface: 'asphalt' }, geometry: [{ lat: 40, lon: -105 }, { lat: 40.01, lon: -105 }] },
  { type: 'way', id: 5, tags: { highway: 'track', surface: 'asphalt' }, geometry: [{ lat: 40, lon: -105 }, { lat: 40.01, lon: -105 }] },
] });
check('dirt: tracks and unpaved roads, not grade1 or surfaced ones', dirtWays.map(w => w.id + w.k).join() === '1track,3road' && dirtWays[1].n === 'Old Mill Rd', dirtWays.map(w => w.id + w.k).join());

section('Router with a stub network');
(async () => {
  const calls = [];
  let profileUploads = 0, failNextCustom = false, rejectUpload = false, lastUpload = '';
  sandbox.fetch = async (url, opts = {}) => {
    calls.push(url);
    const m = /(\w+)\.brf$/.exec(url);
    if (m) return { ok: true, status: 200, text: async () => brf(m[1]) };
    if (/brouter\/profile$/.test(url)) {
      profileUploads++;
      if (rejectUpload) return { ok: true, status: 200, json: async () => ({ profileid: 'custom_x', error: 'Profile error: ParseException' }) };
      lastUpload = opts.body;
      return { ok: true, status: 200, json: async () => ({ profileid: 'custom_' + profileUploads }) };
    }
    if (/brouter\?/.test(url)) {
      if (/custom_1/.test(url) && failNextCustom) return { ok: false, status: 500, text: async () => 'profile custom_1 not found' };
      const gj = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { voicehints: [[1, 2, 0, 10, -90]], messages: msgs },
        geometry: { type: 'LineString', coordinates: [[-0.1, 51.5, 10], [-0.1, 51.501, 11], [-0.101, 51.501, 12]] } }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(gj) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  Router.setTemplateBase('assets/data/');
  const a = { lat: 51.5, lon: -0.1 }, b = { lat: 51.501, lon: -0.101 };
  const l1 = await Router.leg(a, b, 'gravel-rough');
  check('leg comes back as [lat, lon, ele]', l1.coords[0][0] === 51.5 && l1.coords[0][1] === -0.1 && l1.coords[0][2] === 10);
  check('gravel-rough uploads its own profile and routes with it', profileUploads === 1 && /profile=custom_1&/.test(calls[calls.length - 1]) &&
    /prefer_unpaved_paths true/.test(lastUpload) && /rl_never/.test(lastUpload));
  check('leg carries a surface summary', l1.surface && l1.surface.trail === 40);
  const n = calls.length;
  const l2 = await Router.leg(a, b, 'gravel-rough');
  check('the same leg again is cached', calls.length === n && l2 !== l1 && l2.coords[0] !== l1.coords[0]);
  await Router.leg(a, b, 'mtb-2');
  check('an MTB level uploads its profile and routes with the id', profileUploads === 2 && /profile=custom_2/.test(calls[calls.length - 1]));
  await Router.leg(b, a, 'mtb-2');
  check('…once per level', profileUploads === 2);
  failNextCustom = true;
  calls.length = 0;
  await Router.leg({ lat: 51.6, lon: -0.2 }, b, 'gravel-rough');
  check('an expired profile is uploaded again', profileUploads === 3 && /profile=custom_3/.test(calls[calls.length - 1]), calls.slice(-2).join(' | '));
  failNextCustom = false;
  rejectUpload = true;
  const fb = await Router.leg({ lat: 51.7, lon: -0.3 }, b, 'fastbike');
  check('a profile the server rejects falls back to the stock one, flagged', fb.fallback === true && /profile=fastbike&/.test(calls[calls.length - 1]));
  rejectUpload = false;
  const s = await Router.leg(a, b, 'straight');
  check('straight legs are densified', s.kind === 'straight' && s.coords.length >= 3);

  section('Trail service busy: back off, then recover');
  let tries = 0;
  Trails.setBackoff(30);
  Trails.clearCache();
  Trails.setFetch(async () => {
    tries++;
    if (tries <= 3) return { ok: false, status: 502, json: async () => ({}) };     // all three mirrors busy once
    return { ok: true, status: 200, json: async () => overpass };
  });
  let changes = 0;
  Trails.setListener(() => changes++);
  Trails.want([tk.x + '/' + tk.y]);
  await new Promise(r => setTimeout(r, 15));
  check('a busy server is reported, with a retry', Trails.status().failing && tries === 3, JSON.stringify(Trails.status()));
  await new Promise(r => setTimeout(r, 200));
  check('…and the tile arrives on the retry', Trails.tiles.has(tk.x + '/' + tk.y) && !Trails.status().failing && tries === 4, 'tries ' + tries);
  check('listener told about each change', changes >= 3);
  Trails.setListener(null);
  Trails.clearCache();

  section('Settings stay compatible with CritLab and CrossLab');
  // A fresh page: Settings caches the blob on first read, so use a new context
  // whose storage already holds what the other two tools wrote.
  const page = { console, JSON, Object, localStorage: memStorage(), sessionStorage: memStorage(), self: {} };
  page.localStorage.setItem('cl-settings', JSON.stringify({ ftp: 301, cxLthr: 171, critOnly: 'x', icuAthlete: '42' }));
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(path.join(JS, 'RouteStore.js'), 'utf8'), page);
  const Settings = vm.runInContext('Settings', page);
  Settings.set({ rlUnits: 'mi', rlRidePct: 65 });
  const blob = JSON.parse(page.localStorage.getItem('cl-settings'));
  check('other tools\' keys survive a write', blob.cxLthr === 171 && blob.critOnly === 'x' && blob.icuAthlete === '42');
  check('shared FTP is read, not replaced', Settings.get('ftp') === 301);
  Settings.reset();
  const after = JSON.parse(page.localStorage.getItem('cl-settings'));
  check('reset() clears only RouteLab keys', after.rlUnits === undefined && after.ftp === 301 && after.cxLthr === 171);
  check('every RouteLab-only default is rl-prefixed', Object.keys(Settings.DEFAULTS).filter(k => !['icuAthlete', 'icuAthleteName', 'icuKeyPersist', 'mass', 'crr', 'cda', 'ftp', 'ftpUserSet'].includes(k)).every(k => /^rl[A-Z]/.test(k)));
  const Local = vm.runInContext('Local', page);
  const blobBefore = page.localStorage.getItem('cl-settings');
  Local.setView({ lat: 1, lon: 2, z: 3 }); Local.setCurrent('r1');
  check('map position and open route stay out of the shared blob', page.localStorage.getItem('cl-settings') === blobBefore &&
    Local.view().z === 3 && Local.current() === 'r1');
  check('the key is never written into the blob', (Settings.set({ icuKey: 'secret' }), !/secret/.test(page.localStorage.getItem('cl-settings')) && page.localStorage.getItem('cl-icu-key') === 'secret'));

  section('Units');
  check('miles', Units.dist(1609.344, 'mi') === '1.00 mi' && near(Units.toM(1, 'mi'), 1609.344, 1e-9));
  check('kilometres', Units.dist(12345, 'km') === '12.3 km');
  check('durations', Units.duration(3599) === '1:00' && Units.duration(5400) === '1:30');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
