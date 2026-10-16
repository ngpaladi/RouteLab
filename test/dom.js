'use strict';

/**
 * DOM test. Builds the site with Jekyll, loads the generated index.html into
 * jsdom with a recording canvas stub and a fake network (a router that draws
 * a dog-leg between any two points, the MTB profile upload, elevation,
 * search), then drives the UI the way a person would: the welcome dialog and
 * walkthrough, clicking the map to add points, dragging one, removing one,
 * changing terrain, the sample route, every kind of cue, the exports, and an
 * import.
 *
 *   node test/dom.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'routelab-site-'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

section('Jekyll build');
try {
  execFileSync('jekyll', ['build', '--destination', SITE], { cwd: ROOT, stdio: 'pipe' });
  check('site builds', fs.existsSync(path.join(SITE, 'index.html')));
  check('about page builds', fs.existsSync(path.join(SITE, 'about.html')));
  check('connect page builds', fs.existsSync(path.join(SITE, 'connect.html')));
  check('sample route and the routing profiles are published', fs.existsSync(path.join(SITE, 'assets/data/sample-route.json')) && ['fastbike', 'trekking', 'gravel', 'mtb'].every(n => fs.existsSync(path.join(SITE, 'assets/data/' + n + '.brf'))));
  check('CLAUDE.md, README and tests are not published', !fs.existsSync(path.join(SITE, 'CLAUDE.md')) && !fs.existsSync(path.join(SITE, 'README.md')) && !fs.existsSync(path.join(SITE, 'test')));
} catch (err) {
  check('site builds', false, String(err.stderr || err.message).slice(0, 300));
  process.exit(1);
}

function makeContext() {
  const calls = { fill: 0, stroke: 0, fillText: 0, fillRect: 0, arc: 0, lineTo: 0, drawImage: 0 };
  const noop = () => {};
  return {
    calls, canvas: null,
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: () => calls.lineTo++, arc: () => calls.arc++,
    quadraticCurveTo: noop, rect: noop, clip: noop,
    fill: () => calls.fill++, stroke: () => calls.stroke++, fillRect: () => calls.fillRect++, strokeRect: noop,
    fillText: () => calls.fillText++, strokeText: noop,
    setLineDash: noop, getLineDash: () => [],
    measureText: t => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    drawImage: () => calls.drawImage++,
  };
}

// ── Fake network ───────────────────────────────────────────────────────────
const net = { calls: [], uploads: 0 };
const sample = fs.readFileSync(path.join(ROOT, 'assets/data/sample-route.json'), 'utf8');
const brf = name => fs.readFileSync(path.join(ROOT, 'assets/data', name + '.brf'), 'utf8');
/** Overpass: one blue-square trail running north from wherever the test draws. */
let overpassWays = [];
function fakeOverpass(body) {
  // The dirt-road query: the same lines, as tracks.
  if (/tracktype/.test(decodeURIComponent(body || ''))) {
    return { elements: overpassWays.map((g, k) => ({ type: 'way', id: 700 + k, tags: { highway: 'track', tracktype: 'grade3', name: 'Test Track ' + k },
      geometry: g.map(([lat, lon]) => ({ lat, lon: lon + 0.001 })) })) };
  }
  return { elements: overpassWays.map((g, k) => ({ type: 'way', id: 900 + k, tags: { highway: 'path', name: 'Test Trail ' + k, 'mtb:scale:imba': '2' },
    geometry: g.map(([lat, lon]) => ({ lat, lon })) })) };
}
function resp(status, body, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => (json !== undefined ? json : JSON.parse(body)) };
}
/** A dog-leg: north then east, with a right-angle hint at the corner and a climb. */
function fakeRoute(url) {
  const m = /lonlats=([-\d.]+),([-\d.]+)\|([-\d.]+),([-\d.]+)/.exec(decodeURIComponent(url));
  const [lo1, la1, lo2, la2] = m.slice(1).map(Number);
  const coords = [];
  for (let k = 0; k <= 10; k++) coords.push([lo1, la1 + (la2 - la1) * k / 10, 10 + k * 3]);
  for (let k = 1; k <= 10; k++) coords.push([lo1 + (lo2 - lo1) * k / 10, la2, 40 + k]);
  const right = lo2 > lo1 === la2 > la1;
  return { type: 'FeatureCollection', features: [{ type: 'Feature',
    properties: { voicehints: [[10, right ? 5 : 2, 0, 100, right ? 90 : -90]],
      messages: [['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'],
        ['0', '0', '0', '500', '', '', '', '', '', 'highway=track tracktype=grade3', '', '', ''],
        ['0', '0', '0', '300', '', '', '', '', '', 'highway=residential', '', '', '']] },
    geometry: { type: 'LineString', coordinates: coords } }] };
}
async function fakeFetch(url, opts = {}) {
  url = String(url);
  net.calls.push({ url, method: opts.method || 'GET' });
  if (/sample-route\.json$/.test(url)) return resp(200, sample);
  const m = /assets\/data\/(\w+)\.brf$/.exec(url);
  if (m) return resp(200, brf(m[1]));
  if (/brouter\/profile$/.test(url)) { net.uploads++; net.lastProfile = opts.body; return resp(200, '', { profileid: 'custom_test' + net.uploads }); }
  if (/overpass/.test(url)) {
    if (/tracktype/.test(decodeURIComponent(opts.body || ''))) net.dirt = (net.dirt || 0) + 1; else net.overpass = (net.overpass || 0) + 1;
    return resp(200, '', fakeOverpass(opts.body));
  }
  if (/brouter\?/.test(url)) return resp(200, JSON.stringify(fakeRoute(url)));
  if (/open-meteo\.com\/v1\/elevation/.test(url)) {
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    return resp(200, '', { elevation: Array.from({ length: n }, (_, i) => 100 + i) });
  }
  if (/nominatim/.test(url)) return resp(200, '', [{ display_name: 'Fairfax, Marin County', lat: '37.987', lon: '-122.589', boundingbox: ['37.97', '38.0', '-122.61', '-122.57'] }]);
  return resp(404, 'not found');
}

section('Boot');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => errors.push(e.message + '\n' + (e.stack || '')));
virtualConsole.on('error', (...a) => errors.push(a.map(String).join(' ')));

const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').replace(/(src|href)="\/RouteLab\//g, '$1="');
const baseUrl = require('url').pathToFileURL(path.join(SITE, 'index.html')).href;
const downloads = [];

const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', url: baseUrl, pretendToBeVisual: true, virtualConsole,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () {
      if (!this._ctx) { this._ctx = makeContext(); this._ctx.canvas = this; }
      return this._ctx;
    };
    window.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 440, width: 900, height: 440 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 160, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 60, configurable: true });
    window.devicePixelRatio = 2;
    window.alert = msg => errors.push('alert(): ' + msg);
    window.confirm = () => true;
    window.fetch = fakeFetch;
    // jsdom has neither; real browsers have both (and CompressionStream, left
    // out here so the plain-link fallback is the one exercised).
    window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:x'; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
    // jsdom's Blob predates .text() and .arrayBuffer(); every browser has them.
    const read = (blob, how) => new Promise((res, rej) => {
      const r = new window.FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(r.error);
      r[how](blob);
    });
    if (!window.Blob.prototype.text) window.Blob.prototype.text = function () { return read(this, 'readAsText'); };
    if (!window.Blob.prototype.arrayBuffer) window.Blob.prototype.arrayBuffer = function () { return read(this, 'readAsArrayBuffer'); };
  },
});

const { window } = dom;
const { document } = window;
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G = name => window.eval(name);

function pointer(type, x, y, extra = {}) {
  const e = new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...extra });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}
function clickMap(x, y) {
  const c = App().map.canvas;
  c.dispatchEvent(pointer('pointerdown', x, y));
  c.dispatchEvent(pointer('pointerup', x, y));
}
function dragMap(x0, y0, x1, y1) {
  const c = App().map.canvas;
  c.dispatchEvent(pointer('pointerdown', x0, y0));
  for (let k = 1; k <= 5; k++) c.dispatchEvent(pointer('pointermove', x0 + (x1 - x0) * k / 5, y0 + (y1 - y0) * k / 5));
  c.dispatchEvent(pointer('pointerup', x1, y1));
}
const App = () => window.RouteLabApp;
const R = () => App().state.route;
async function settle() { for (let k = 0; k < 20; k++) { await sleep(15); if (!App().state.inflight.size) break; } await sleep(20); }
function setValue(id, v) { const el = $(id); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); }
async function lastDownload() { const b = downloads[downloads.length - 1]; return b ? await b.text() : ''; }

/** Boot another built page in its own jsdom, network off, errors collected. */
async function bootPage(file) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(e.message));
  vc.on('error', (...a) => errs.push(a.map(String).join(' ')));
  const src = fs.readFileSync(path.join(SITE, file), 'utf8').replace(/(src|href)="\/RouteLab\//g, '$1="');
  const page = new JSDOM(src, {
    runScripts: 'dangerously', resources: 'usable', virtualConsole: vc,
    url: require('url').pathToFileURL(path.join(SITE, file)).href,
    beforeParse(w) { w.fetch = () => Promise.reject(new Error('network disabled')); },
  });
  await new Promise(r => page.window.document.readyState === 'complete' ? r() : page.window.addEventListener('load', r));
  await sleep(100);
  return { window: page.window, document: page.window.document, errors: errs };
}

(async () => {
  await new Promise(resolve => document.readyState === 'complete' ? resolve() : window.addEventListener('load', resolve));
  await sleep(300);

  check('no errors on boot', errors.length === 0, errors.join(' | ').slice(0, 400));
  check('modules present', ['Intervals', 'RouteStore', 'Settings', 'Geo', 'Router', 'Cues', 'Gpx', 'Units', 'TileMap', 'Trails', 'Profile', 'Tour', 'Fit'].every(n => { try { return !!G(n); } catch (_) { return false; } }));
  check('map canvas mounted', !!document.querySelector('#map-area canvas.tilemap-canvas'));
  check('cycle map by default, attributed', /CyclOSM/.test(document.querySelector('.tilemap-attr').textContent) && /OpenStreetMap/.test(document.querySelector('.tilemap-attr').textContent));
  check('empty profile prompts to start', $('profile')._ctx.calls.fillText > 0);
  check('terrain picker grouped by discipline', document.querySelectorAll('#route-profile optgroup').length === 4 && $('route-profile').querySelector('option[value="mtb-3"]'));

  section('Getting started');
  check('welcome dialog when not connected', !!$('welcome-connect') && /connect\.html$/.test($('welcome-connect').getAttribute('href')));
  $('welcome-later').click();
  await sleep(20);
  check('"Not now" starts the walkthrough', !!document.querySelector('.tour-walk'));
  let steps = 0;
  while (document.querySelector('.tour-walk') && steps < 20) { $('tour-next').click(); steps++; await sleep(5); }
  check('walkthrough runs to the end', !document.querySelector('.tour-walk') && steps >= 5, steps + ' steps');
  check('tour marked done', G('Settings').get('rlTourDone') === true && G('Settings').get('rlWelcomeSeen') === true);

  section('Drawing');
  const map = App().map;
  map.setView(37.95, -122.6, 13);
  await sleep(30);
  clickMap(300, 300);
  check('first click adds a start point', R().waypoints.length === 1 && R().legs.length === 0);
  clickMap(500, 200);
  clickMap(700, 300);
  check('two more clicks: three points, two legs', R().waypoints.length === 3 && R().legs.length === 2);
  check('legs are pending until routed', R().legs.every(l => l.kind === 'pending'));
  await settle();
  check('legs come back routed', R().legs.every(l => l.kind === 'route'), R().legs.map(l => l.kind).join(','));
  check('routing uploads a road profile that bans sidewalks', net.uploads === 1 && /rl_never/.test(net.lastProfile) && net.calls.some(c => /brouter\?.*profile=custom_test1/.test(c.url)));
  const len1 = App().state.track.length;
  check('stats show the distance', /km/.test($('route-stats').textContent) && len1 > 0, (len1 / 1000).toFixed(2) + ' km');
  check('surface split shown', /Gravel \d+%/.test($('route-stats').textContent) && /Paved/.test($('route-stats').textContent));
  check('route drawn on the map', map.canvas.getContext('2d').calls.lineTo > 20);
  check('profile drawn', $('profile')._ctx.calls.fillRect > 50);
  check('turn cues derived', App().state.cues.some(c => c.type === 'right' || c.type === 'left'));

  section('Editing');
  const wp1 = map.project(R().waypoints[1].lat, R().waypoints[1].lon);
  dragMap(wp1.x, wp1.y, wp1.x + 60, wp1.y - 40);
  check('dragging a point moves it', Math.abs(map.project(R().waypoints[1].lat, R().waypoints[1].lon).x - (wp1.x + 60)) < 2);
  await settle();
  check('both legs touching it re-routed', R().legs.every(l => l.kind === 'route'));
  $('undo-btn').click();
  await settle();
  check('undo puts it back', Math.abs(map.project(R().waypoints[1].lat, R().waypoints[1].lon).x - wp1.x) < 2 && R().legs.every(l => l.kind === 'route'));
  $('redo-btn').click();
  await settle();
  check('redo moves it again', Math.abs(map.project(R().waypoints[1].lat, R().waypoints[1].lon).x - (wp1.x + 60)) < 2);

  // Drag the middle of the first leg: a new point is inserted there.
  const t0 = App().state.track;
  const mi = Math.round(t0.legStart[1] / 2);
  const onLine = map.project(t0.lat[mi], t0.lon[mi]);
  dragMap(onLine.x, onLine.y, onLine.x - 50, onLine.y + 30);
  await settle();
  check('dragging the line inserts a point', R().waypoints.length === 4 && R().legs.length === 3);

  const wp2 = map.project(R().waypoints[1].lat, R().waypoints[1].lon);
  clickMap(wp2.x, wp2.y);
  check('clicking a point selects it', !$('wp-bar').hidden && /Point 2 of 4/.test($('wp-bar').textContent));
  $('wp-remove').click();
  await settle();
  check('Remove deletes it and joins its neighbours', R().waypoints.length === 3 && R().legs.length === 2 && R().legs.every(l => l.kind === 'route'));

  $('loop-btn').click();
  await settle();
  const w = R().waypoints;
  check('Close loop routes back to the start', w.length === 4 && w[3].lat === w[0].lat && w[3].lon === w[0].lon);
  const loopLen = App().state.track.length;
  $('back-btn').click();
  check('Out & back doubles it without asking the router', Math.abs(App().state.track.length - 2 * loopLen) < 1 && R().legs.length === 6);
  check('…and mirrors the turns', App().state.cues.filter(c => c.type === 'left').length > 0 && App().state.cues.filter(c => c.type === 'right').length > 0);
  $('undo-btn').click();

  section('Terrain and skill');
  const before = net.calls.length;
  setValue('route-profile', 'mtb-3');
  await settle();
  const after = net.calls.slice(before);
  check('MTB level uploads its profile', after.some(c => /brouter\/profile$/.test(c.url) && c.method === 'POST') && /RouteLab: MTB level 3/.test(net.lastProfile));
  const id = 'custom_test' + net.uploads;
  check('…and routes every leg with it', after.filter(c => c.url.includes('profile=' + id + '&')).length === R().legs.length, after.filter(c => /custom_test/.test(c.url)).length + ' legs');
  check('terrain hint describes the level', /S3/.test($('terrain-hint').textContent));
  setValue('route-profile', 'gravel-rough');
  await settle();
  check('rough gravel uploads a profile preferring dirt and taking bike lanes', /prefer_unpaved_paths true/.test(net.lastProfile) && /any_cycleway 1\.9 3\.0/.test(net.lastProfile) && /roundabout 15 150/.test(net.lastProfile));
  check('terrain is remembered for next time', G('Settings').get('rlProfile') === 'gravel-rough');
  setValue('route-profile', 'straight');
  await settle();
  check('straight line asks for elevation instead', R().legs.every(l => l.kind === 'straight') && net.calls.some(c => /open-meteo/.test(c.url)));
  $('undo-btn').click(); $('undo-btn').click(); $('undo-btn').click();
  await settle();
  check('undo walks the terrain back', R().profile === 'fastbike' && R().legs.every(l => l.kind === 'route'), R().profile);

  section('Sample route');
  $('demo-btn').click();
  await settle(); await sleep(50);
  const st = App().state;
  check('sample loads', R().source === 'sample' && R().waypoints.length === 8 && Math.abs(st.track.length - 69450) < 400, (st.track.length / 1000).toFixed(1) + ' km');
  check('…with eat, drink and climb power cues', ['eat', 'drink', 'power'].every(t => R().cues.some(c => c.type === t)));
  check('cue sheet lists them', $('cue-rows').querySelectorAll('tr[data-id]').length === R().cues.length + R().cues.filter(c => c.type === 'power' && c.endM).length);
  check('turn rows hidden until asked for', !$('cue-rows').querySelector('tr.cue-turn'));
  $('show-turns').click();
  check('show turns lists them', $('cue-rows').querySelectorAll('tr.cue-turn').length > 10);
  $('show-turns').click();
  check('stats include climbing and time', /m/.test($('route-stats').textContent) && /\d:\d\d/.test($('route-stats').textContent));

  section('Cues');
  const nBefore = R().cues.length;
  setValue('cue-type', 'drink');
  setValue('cue-at', '12.5');
  setValue('cue-label', 'Refill at the store');
  $('cue-add-btn').click();
  const added = R().cues.find(c => c.label === 'Refill at the store');
  check('one cue added at the typed distance', added && Math.abs(added.atM - 12500) < 1e-6 && R().cues.length === nBefore + 1);

  // Profile click puts a distance into the form.
  const prof = $('profile');
  prof.dispatchEvent(new window.MouseEvent('click', { clientX: 44 + (900 - 56) / 2, clientY: 50, bubbles: true }));
  check('clicking the profile sets the cue distance', Math.abs(+$('cue-at').value - 34.7) < 0.3, $('cue-at').value);

  // Pick on map.
  $('cue-pick').click();
  check('pick mode shown', !$('map-mode').hidden);
  const k = 2000, pk = map.project(st.track.lat[k], st.track.lon[k]);
  clickMap(pk.x, pk.y);
  check('picking on the map sets the distance and leaves pick mode', Math.abs(+$('cue-at').value - st.track.d[k] / 1000) < 0.15 && $('map-mode').hidden && R().waypoints.length === 8);

  document.querySelector('#cue-kind button[data-kind="series"]').click();
  check('series form shown', !$('form-series').hidden && $('form-one').hidden);
  setValue('ser-type', 'eat');
  setValue('ser-every', '10'); setValue('ser-from', '5'); setValue('ser-to', '45'); setValue('ser-label', 'Gel');
  check('series preview counts them', /^5 cues at 5, 15, 25/.test($('ser-preview').textContent), $('ser-preview').textContent);
  $('ser-add-btn').click();
  const gels = R().cues.filter(c => c.label === 'Gel');
  check('series added', gels.length === 5 && new Set(gels.map(c => c.series)).size === 1);
  const row = $('cue-rows').querySelector('tr[data-id="' + gels[0].id + '"] .cue-del-series');
  row.click();
  check('remove the whole series in one go', !R().cues.some(c => c.label === 'Gel'));
  $('undo-btn').click();
  check('undo brings the series back', R().cues.filter(c => c.label === 'Gel').length === 5);

  document.querySelector('#cue-kind button[data-kind="power"]').click();
  setValue('pw-from', '10'); setValue('pw-to', '14'); setValue('pw-unit', 'w'); setValue('pw-watts', '280');
  check('power preview gives % FTP and a duration', /280 W = 112% of your 250 W FTP/.test($('pw-preview').textContent) && /about \d:\d\d/.test($('pw-preview').textContent), $('pw-preview').textContent);
  $('pw-add-btn').click();
  const p280 = R().cues.find(c => c.type === 'power' && c.watts === 280);
  check('power target added', p280 && p280.atM === 10000 && p280.endM === 14000);
  setValue('pw-unit', 'pct');
  check('switching to % FTP converts the number', $('pw-watts').value === '112');
  setValue('pw-watts', '90');
  $('pw-climbs').click();
  const climbTargets = R().cues.filter(c => c.type === 'power' && c.watts === 225);
  check('a target on every climb, replacing the sample\'s', climbTargets.length >= 2 && !R().cues.some(c => c.type === 'power' && c.watts === 220), climbTargets.length + ' climbs');

  // Inline edits.
  const tr = $('cue-rows').querySelector('tr[data-id="' + added.id + '"]');
  const txt = tr.querySelector('.cue-text');
  txt.value = 'Shop'; txt.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('cue text edits in place', R().cues.find(c => c.id === added.id).label === 'Shop');
  const at = $('cue-rows').querySelector('tr[data-id="' + added.id + '"] .cue-at');
  at.value = '13'; at.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('cue distance edits in place', R().cues.find(c => c.id === added.id).atM === 13000);
  $('cue-rows').querySelector('tr[data-id="' + added.id + '"] .cue-del').click();
  check('cue deleted', !R().cues.some(c => c.id === added.id));

  section('Export');
  $('export-turns').checked = true;
  $('export-gpx').click();
  const gpx = await lastDownload();
  const wpt = gpx.match(/<wpt lat="[^"]+" lon="[^"]+"/g) || [];
  const trk = new Set((gpx.match(/<trkpt lat="[^"]+" lon="[^"]+"/g) || []).map(s => s.replace('trkpt', 'wpt')));
  const expect = App().exportCues().length;
  check('GPX has a waypoint per cue, turns included', wpt.length === expect && expect > R().cues.length, wpt.length + ' waypoints');
  check('every waypoint is on the track', wpt.every(x => trk.has(x)));
  check('GPX carries Food, Water and power cues', /<type>Food<\/type>/.test(gpx) && /<type>Water<\/type>/.test(gpx) && /<name>225W/.test(gpx));
  check('export status reports it', /Exported .*\.gpx with \d+ cues/.test($('cue-status').textContent));
  $('export-turns').checked = false;
  $('export-tcx').click();
  const tcx = await lastDownload();
  const cps = (tcx.match(/<CoursePoint>/g) || []).length;
  check('TCX without turns has only your cues', cps === App().exportCues().length && !/<PointType>(Left|Right)<\/PointType>/.test(tcx), cps + ' course points');
  $('export-csv').click();
  const csv = await lastDownload();
  check('cue sheet CSV', /^distance,eta,type,cue,note/.test(csv) && csv.trim().split('\n').length === cps + 1);
  $('export-json').click();
  const json = JSON.parse(await lastDownload());
  check('JSON export round-trips', G('RouteStore').fromJson(json) && json.cues.length === R().cues.length && json.format === 'routelab-route-1');

  section('Share a link');
  const srcRoute = { name: R().name, wps: R().waypoints.length, cues: R().cues.filter(c => !c.auto).length, profile: R().profile };
  $('share-btn').click();
  for (let k = 0; k < 20 && $('share-url').hidden; k++) await sleep(20);
  const link = $('share-url').value;
  check('Copy link makes a #r= link to this page', !$('share-url').hidden && /^[^#]+#r=[jz][A-Za-z0-9_-]+$/.test(link) && /Link copied|Copy the link/.test($('share-status').textContent), link.slice(0, 80));
  window.location.hash = link.slice(link.indexOf('#'));
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  for (let k = 0; k < 40 && R().source !== 'link'; k++) await sleep(20);
  await settle();
  check('opening it gives a copy: same name, terrain, points and cues', R().source === 'link' && R().name === srcRoute.name && R().profile === srcRoute.profile &&
    R().waypoints.length === srcRoute.wps && R().cues.length === srcRoute.cues, JSON.stringify({ src: srcRoute, got: [R().source, R().name, R().waypoints.length, R().cues.length] }));
  check('…routed afresh', R().legs.every(l => l.kind === 'route' || l.kind === 'track'));
  check('…the link is cleared from the address bar and the route is said to be saved', !window.location.hash && /from a link/.test($('route-status').textContent), JSON.stringify([window.location.hash.slice(0, 20), $('route-status').textContent]));
  window.location.hash = '#r=jbm9wZQ';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(50);
  check('a damaged link says so and leaves the route alone', R().source === 'link' && /damaged/.test($('route-status').textContent));

  section('Import');
  const input = $('file-input');
  const file = new window.File([gpx], 'Marin loop.gpx', { type: 'application/gpx+xml' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await sleep(200);
  check('GPX import becomes a fixed track', R().source === 'file' && R().legs.length === 1 && R().legs[0].kind === 'track');
  check('…the same length', Math.abs(App().state.track.length - 69450) < 400, (App().state.track.length / 1000).toFixed(1) + ' km');
  check('…its waypoints become cues', R().cues.length === wpt.length && R().cues.some(c => c.type === 'eat') && R().cues.some(c => c.type === 'right'));
  check('import status', /Imported .* with \d+ cues/.test($('route-status').textContent), $('route-status').textContent);
  clickMap(100, 100);
  await settle();
  // The import took the last terrain used (straight line, from the terrain section).
  check('a click extends an imported track with a new leg', R().legs.length === 2 && R().legs[0].kind === 'track' && R().legs[1].kind === (R().profile === 'straight' ? 'straight' : 'route'), R().profile);
  setValue('route-profile', 'gravel');
  await settle();
  check('changing terrain re-routes the new leg but keeps the imported line', R().legs[0].kind === 'track' && R().legs[1].kind === 'route');

  section('Map layers and trail ratings');
  $('layers-btn').click();
  check('layers panel lists the map styles and the overlay', !$('layer-panel').hidden && $('layer-panel').querySelectorAll('input[name=tiles]').length === 3 && $('layer-trails').checked);
  const topo = $('layer-panel').querySelector('input[value=topo]');
  topo.checked = true; topo.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('switching style from the panel', /OpenTopoMap/.test(document.querySelector('.tilemap-attr').textContent) && G('Settings').get('rlTiles') === 'topo');
  document.body.click();
  check('panel closes on an outside click', $('layer-panel').hidden);
  // Lay a rated trail along the start of the route and pan so it is fetched.
  const rt = App().state.track;
  overpassWays = [Array.from({ length: 40 }, (_, k) => [rt.lat[Math.min(rt.n - 1, k * 5)], rt.lon[Math.min(rt.n - 1, k * 5)]])];
  G('Trails').clearCache();
  map.setView(rt.lat[0], rt.lon[0], 14);
  await sleep(500);
  for (let k = 0; k < 20 && G('Trails').status().loading; k++) await sleep(50);
  await sleep(100);
  check('trail ratings fetched from Overpass for the view', net.overpass >= 1);
  check('legend shown', !$('trail-legend').hidden && /Trail ratings/.test($('trail-legend').textContent) && /Blue/.test($('trail-legend').textContent));
  check('the route rides a rated trail', (App().state.trailRuns || []).length >= 1 && /Test Trail 0/.test($('route-stats').textContent), (App().state.trailRuns || []).length + ' runs');
  check('hardest rating named', /hardest: .*Blue square/.test($('route-stats').textContent));
  G('Trails').dirt.clearCache();
  map.setView(rt.lat[0], rt.lon[0], 14.2);
  await sleep(500);
  for (let k = 0; k < 20 && G('Trails').dirt.status().loading; k++) await sleep(50);
  await sleep(100);
  check('gravel level: dirt roads fetched for the view', net.dirt >= 1 && G('Trails').dirt.waysIn(rt.lat[0] - 0.05, rt.lon[0] - 0.05, rt.lat[0] + 0.05, rt.lon[0] + 0.05).some(w => w.k === 'track'), 'requests ' + net.dirt);
  check('…the route knows where it is unpaved', (App().state.track.dirt || []).some(sp => sp.kind === 'gravel' && sp.toM - sp.fromM > 300), JSON.stringify(App().state.track.dirt));
  check('…and the legend says so', /Dirt/.test($('trail-legend').textContent) && /Track/.test($('trail-legend').textContent) && /On your route/.test($('trail-legend').textContent));
  const p0 = map.project(overpassWays[0][10][0], overpassWays[0][10][1]);
  const c = App().map.canvas;
  c.dispatchEvent(pointer('pointermove', p0.x + 30, p0.y + 30));
  c.dispatchEvent(pointer('pointermove', p0.x, p0.y));
  check('hovering a trail or cue shows a tooltip', !$('map-tip').hidden && /Test Trail 0|Blue square|·/.test($('map-tip').textContent), $('map-tip').textContent.slice(0, 80));
  const nCues = R().cues.length;
  $('trail-cues-btn').click();
  const tc = R().cues.filter(x => x.type === 'trail');
  check('Add trail cues puts the rating in the cue', tc.length >= 1 && /^BLU Test Trail 0/.test(tc[0].label) && R().cues.length === nCues + tc.length, tc.map(x => x.label).join());
  $('trail-cues-btn').click();
  check('…and again replaces rather than duplicates', R().cues.filter(x => x.type === 'trail').length === tc.length);
  $('layers-btn').click();
  $('layer-trails').checked = false; $('layer-trails').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('turning the overlay off drops ratings from the legend and the trail list', !/Trail ratings/.test($('trail-legend').textContent) && !/Rated trails/.test($('route-stats').textContent));
  $('layer-dirt').checked = false; $('layer-dirt').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('…and with dirt off too, only the route’s own dirt is in the legend', !/Road/.test($('trail-legend').textContent) && /On your route/.test($('trail-legend').textContent) && G('Settings').get('rlDirt') === false);
  $('layer-dirt').checked = true; $('layer-dirt').dispatchEvent(new window.Event('change', { bubbles: true }));
  $('layer-trails').checked = true; $('layer-trails').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.body.click();

  section('Search and settings');
  setValue('search-input', 'Fairfax');
  $('search-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(50);
  const res = $('search-results').querySelector('[data-k]');
  check('search lists places', res && /Fairfax/.test(res.textContent));
  res.click();
  check('choosing one moves the map', Math.abs(map.view().lat - 37.985) < 0.02 && $('search-results').hidden);

  $('settings-btn').click();
  check('settings drawer opens with shared FTP', $('settings-modal').style.display === '' && $('set-ftp').value === '250');
  setValue('set-units', 'mi');
  check('miles everywhere', /mi/.test($('route-stats').textContent) && [...document.querySelectorAll('.unit-label')].every(e => e.textContent === 'mi'));
  setValue('set-units', 'km');
  setValue('set-ftp', '300');
  check('FTP is shared and marked as set by you', G('Settings').get('ftp') === 300 && G('Settings').get('ftpUserSet') === true);
  setValue('set-tiles', 'osm');
  setValue('set-tiles', 'cyclosm');
  check('map style switches', /CyclOSM/.test(document.querySelector('.tilemap-attr').textContent));
  check('trail overlay in settings too', $('set-trails').checked === true);
  setValue('set-slight', true); $('set-slight').checked = true; $('set-slight').dispatchEvent(new window.Event('change'));
  check('slight turns setting saved', G('Settings').get('rlSlightTurns') === true);
  $('settings-close').click();

  section('New route');
  $('new-btn').click();
  await sleep(50);
  check('New route starts empty', R().waypoints.length === 0 && /New route/.test($('route-status').textContent));
  check('cue sheet empties', /No route yet/.test($('cue-rows').textContent));

  check('no errors during the run', errors.length === 0, errors.join(' | ').slice(0, 600));

  section('Other pages');
  for (const f of ['about.html', 'connect.html']) {
    const p = await bootPage(f);
    check(f + ' boots without errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
    if (f === 'connect.html') {
      check('connect page names all three tools', /CritLab/.test(p.document.body.textContent) && /CrossLab/.test(p.document.body.textContent) && /RouteLab/.test(p.document.querySelector('.privacy-callout').textContent));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
