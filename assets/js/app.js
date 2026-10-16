'use strict';

/**
 * RouteLab — UI orchestration.
 *
 * One route is open at a time. Every edit goes through `commit()`, which
 * snapshots for undo, rebuilds the track, re-renders and schedules a save.
 * Leg objects are treated as immutable (replaced, never edited in place), so
 * an undo snapshot can share them by reference instead of copying geometry.
 */
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    route: RouteStore.blank(),
    track: null,
    times: null,
    cues: [],               // everything shown: custom + power ends + turns
    undo: [], redo: [],
    selectedWp: null,
    hoverM: null,
    pick: null,             // 'cue' | 'pw-from' | 'pw-to' — the next map click sets a distance
    drag: null,
    saved: [],
    inflight: new Set(),
    kind: 'one',
  };
  let map, profile, saveTimer = null, busyDepth = 0, screen = null;

  const units = () => Settings.get('rlUnits') || 'km';
  const toM = v => Units.toM(+v, units());
  const fromM = m => Units.distNum(m, units());
  const fmt = m => Units.dist(m, units());
  const round1 = x => Math.round(x * 10) / 10;

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    Router.setTemplateBase(location.pathname.replace(/[^/]*$/, '') + 'assets/data/');
    map = TileMap.create($('map-area'), {
      onDraw: drawOverlay, hitTest, onClick: mapClick,
      onDragStart: dragStart, onDrag: dragMove, onDragEnd: dragEnd,
      onHover: mapHover, onView: v => { saveView(v); requestTrails(); },
      units: () => units(),
    });
    Trails.setListener(() => { map.redraw(); renderTrailLegend(); matchTrails(); });
    Trails.dirt.setListener(() => { map.redraw(); renderTrailLegend(); });
    map.setLayer(Settings.get('rlTiles'));
    const v = Local.view();
    if (v && isFinite(v.lat)) map.setView(v.lat, v.lon, v.z);
    else map.setView(39, -98, 4);

    profile = Profile.create($('profile'), {
      onHover: m => { state.hoverM = m; map.redraw(); },
      onPick: m => pickDistance(m),
    });

    wire();
    fillSelects();
    applyUnits();
    renderIcuConnection();

    try { state.saved = await RouteStore.list(); } catch (_) { state.saved = []; }
    const cur = Local.current();
    const found = cur && state.saved.find(r => r.id === cur);
    if (found) openRoute(found, { fit: !v });
    else rebuild();
    renderList();

    gettingStarted();
  }

  // ── Getting started ───────────────────────────────────────────────────────

  function connectUrl() {
    return location.pathname.replace(/[^/]*$/, '') + 'connect.html';
  }

  /**
   * First visit: a welcome dialog if intervals.icu isn't connected, then the
   * walkthrough. Each is shown once (rlWelcomeSeen, rlTourDone); ?tour=1 from
   * the settings drawer replays the walkthrough.
   */
  function gettingStarted() {
    const replay = /[?&]tour=1\b/.test(location.search);
    if (replay) history.replaceState(null, '', location.pathname);
    if (!replay && Settings.get('rlTourDone')) return;
    if (!replay && !Settings.get('icuKey') && !Settings.get('rlWelcomeSeen')) welcome();
    else walkthrough();
  }

  function welcome() {
    Settings.set({ rlWelcomeSeen: true });
    Tour.dialog({
      title: 'Welcome to RouteLab',
      body:
        '<p>Plan a ride on the map, then add the cues you want on the day &mdash; eat every ' +
        '45 minutes&rsquo; worth of road, drink, hold 260 W up the long climb &mdash; and export it ' +
        'as a GPX or TCX your head unit will prompt you from.</p>' +
        '<p>intervals.icu is optional here: connect it to start a route from a past ride and to ' +
        'use your FTP for power targets. It is the same connection CritLab and CrossLab use.</p>',
      actions: [
        { label: 'Connect intervals.icu', primary: true, href: connectUrl(), id: 'welcome-connect' },
        { label: 'Not now', id: 'welcome-later', onClick: walkthrough },
      ],
      onDismiss: () => Settings.set({ rlTourDone: true }),
    });
  }

  function walkthrough() {
    const on = !!Settings.get('icuKey');
    Tour.start([
      { el: '.mobile-nav', title: 'Three screens',
        body: '<b>Routes</b> holds your saved routes and imports, <b>Map</b> is where you draw, ' +
              'and <b>Cues</b> is the cue sheet and the export.' },
      { el: '#map-area', title: 'Draw on the map',
        body: 'Click to add points; the route follows roads between them. Drag a point to move it, ' +
              'drag the line to route through somewhere new. Search for a place at the top.' },
      { el: '#route-section', title: 'The route',
        body: 'Distance, climbing and a time estimate from your FTP. Choose road, gravel or MTB routing, ' +
              'close the loop or make it an out-and-back. Everything saves as you go.' },
      { el: '#profile', title: 'Elevation',
        body: 'Shaded by gradient. Hover to see where you are on the map; click to put a cue at that spot.' },
      { el: '#cue-add', title: 'Cues',
        body: 'A single cue, a repeating one (<b>eat every 20 km</b>), or a <b>power target</b> held over ' +
              'a stretch of road &mdash; or on every climb at once.' },
      { el: '#export-section', title: 'Take it with you',
        body: 'GPX puts each cue on the track as a waypoint; TCX writes Garmin course points. ' +
              'The cue sheet is a spreadsheet you can print.' },
      on
        ? { el: '#icu-panel', title: 'From intervals.icu',
            body: 'Trace any past ride with GPS as a starting point, and pull in your FTP.' }
        : { el: '#icu-connect', title: 'intervals.icu',
            body: 'Optional: connect to trace past rides and use your FTP. CritLab and CrossLab share it.' },
      { el: '#demo-btn', title: 'Try one',
        body: 'The sample is a hilly 69 km loop in Marin with eat, drink and power cues already on it.' },
      { el: '#settings-btn', title: 'Settings',
        body: 'Units, map style, FTP and weight for the time estimate, turn-cue options, and this tour again.' },
    ], { onEnd: () => Settings.set({ rlTourDone: true }) });
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function wire() {
    $('route-name').addEventListener('change', e => { snapshot(); state.route.name = e.target.value.trim() || 'Untitled route'; changed(); });
    $('route-profile').addEventListener('change', e => setProfile(e.target.value));
    $('undo-btn').addEventListener('click', undo);
    $('redo-btn').addEventListener('click', redo);
    $('loop-btn').addEventListener('click', closeLoop);
    $('back-btn').addEventListener('click', outAndBack);
    $('reverse-btn').addEventListener('click', reverse);
    $('clear-btn').addEventListener('click', () => {
      if (!state.route.waypoints.length) return;
      snapshot();
      state.route.waypoints = []; state.route.legs = []; state.route.cues = [];
      state.selectedWp = null;
      changed();
      say('route-status', 'info', 'Cleared. Undo brings it back.');
    });
    $('new-btn').addEventListener('click', () => newRoute());
    $('demo-btn').addEventListener('click', loadSample);

    $('zoom-in').addEventListener('click', () => map.zoomBy(1));
    $('zoom-out').addEventListener('click', () => map.zoomBy(-1));
    $('zoom-fit').addEventListener('click', fit);
    $('locate-btn').addEventListener('click', locate);
    $('layers-btn').addEventListener('click', e => { e.stopPropagation(); $('layer-panel').hidden = !$('layer-panel').hidden; renderLayers(); });
    document.addEventListener('click', e => { if (!e.target.closest('#layer-panel, #layers-btn')) $('layer-panel').hidden = true; });
    $('layer-panel').addEventListener('change', e => {
      if (e.target.name === 'tiles') { Settings.set({ rlTiles: e.target.value }); map.setLayer(e.target.value); }
      if (e.target.id === 'layer-trails') { Settings.set({ rlTrails: e.target.checked }); matchTrails(); renderTrailLegend(); map.redraw(); requestTrails(); }
      if (e.target.id === 'layer-dirt') { Settings.set({ rlDirt: e.target.checked }); renderTrailLegend(); map.redraw(); requestTrails(); }
    });

    const dz = $('dropzone'), fi = $('file-input');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('is-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('is-over'); if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', () => { if (fi.files[0]) importFile(fi.files[0]); fi.value = ''; });

    let searchTimer = null;
    $('search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); search(e.target.value); }
      if (e.key === 'Escape') { $('search-results').hidden = true; }
    });

    $('icu-fetch').addEventListener('click', icuList);
    $('icu-ftp').addEventListener('click', icuFtp);

    // Cue forms.
    $('cue-kind').addEventListener('click', e => {
      const b = e.target.closest('button[data-kind]');
      if (!b) return;
      state.kind = b.dataset.kind;
      document.querySelectorAll('#cue-kind button').forEach(x => x.classList.toggle('active', x === b));
      $('form-one').hidden = state.kind !== 'one';
      $('form-series').hidden = state.kind !== 'series';
      $('form-power').hidden = state.kind !== 'power';
      setPick(null);
      previews();
    });
    $('cue-type').addEventListener('change', () => { $('cue-label').placeholder = Cues.TYPES[$('cue-type').value].name; });
    $('ser-type').addEventListener('change', () => { $('ser-label').placeholder = Cues.TYPES[$('ser-type').value].name; previews(); });
    $('cue-pick').addEventListener('click', () => setPick(state.pick === 'cue' ? null : 'cue'));
    $('pw-pick').addEventListener('click', () => setPick(state.pick === 'pw-from' ? null : 'pw-from'));
    $('pw-pick-to').addEventListener('click', () => setPick(state.pick === 'pw-to' ? null : 'pw-to'));
    $('cue-add-btn').addEventListener('click', addOne);
    $('ser-add-btn').addEventListener('click', addSeries);
    $('pw-add-btn').addEventListener('click', addPower);
    $('pw-climbs').addEventListener('click', addClimbPower);
    ['ser-every', 'ser-from', 'ser-to', 'pw-from', 'pw-to', 'pw-watts', 'pw-unit'].forEach(id =>
      $(id).addEventListener('input', previews));
    $('pw-unit').addEventListener('change', () => {
      const ftp = Settings.get('ftp') || 250, w = $('pw-watts');
      w.value = $('pw-unit').value === 'pct' ? Math.round(100 * (+w.value || 0) / ftp) : Math.round((+w.value || 0) * ftp / 100);
      previews();
    });

    $('show-turns').checked = !!Settings.get('rlShowTurns');
    $('show-turns').addEventListener('change', e => { Settings.set({ rlShowTurns: e.target.checked }); render(); });
    $('export-turns').checked = Settings.get('rlTurnCues') !== false;
    $('export-turns').addEventListener('change', e => Settings.set({ rlTurnCues: e.target.checked }));

    $('cue-rows').addEventListener('click', cueRowClick);
    $('cue-rows').addEventListener('change', cueRowEdit);
    $('cue-rows').addEventListener('mouseover', e => {
      const tr = e.target.closest('tr[data-at]');
      if (tr) { state.hoverM = +tr.dataset.at; map.redraw(); profile.setHover(state.hoverM); }
    });

    $('export-gpx').addEventListener('click', () => exportAs('gpx'));
    $('export-tcx').addEventListener('click', () => exportAs('tcx'));
    $('export-csv').addEventListener('click', () => exportAs('csv'));
    $('export-json').addEventListener('click', () => exportAs('json'));

    $('route-list').addEventListener('click', listClick);
    $('route-stats').addEventListener('click', e => {
      const row = e.target.closest('.trail-row');
      if (!row) return;
      state.hoverM = +row.dataset.at;
      const p = RouteStore.positionAt(state.track, state.hoverM);
      if (p) map.setView(p.lat, p.lon, Math.max(map.view().z, 15));
      profile.setHover(state.hoverM);
    });

    document.querySelectorAll('.mobile-tab').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(x => x.classList.toggle('active', x === b));
      $('app-wrap').dataset.panel = b.dataset.mpanel;
      if (b.dataset.mpanel === 'map') setTimeout(() => { map.resize(); profile.draw(); }, 0);
    }));

    document.addEventListener('keydown', e => {
      if (Tour.isOpen()) return;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && state.selectedWp != null) { e.preventDefault(); removeWaypoint(state.selectedWp); }
      else if (e.key === 'Escape') { setPick(null); selectWp(null); }
    });

    window.addEventListener('routelab:settings', e => {
      const d = e.detail || {};
      if (d.icu) renderIcuConnection();
      if (d.tiles) map.setLayer(Settings.get('rlTiles'));
      if (d.trails) { matchTrails(); renderTrailLegend(); requestTrails(); map.redraw(); }
      if (d.units) applyUnits();
      if (d.cleared) { state.saved = []; renderList(); }
      rebuild();
    });
  }

  function renderLayers() {
    const cur = Settings.get('rlTiles');
    $('layer-panel').innerHTML =
      '<div class="lp-title">Map</div>' +
      Object.entries(TileMap.LAYERS).map(([k, v]) =>
        '<label class="lp-row"><input type="radio" name="tiles" value="' + k + '"' + (k === cur ? ' checked' : '') + '><span>' + esc(v.name) + '</span></label>').join('') +
      '<div class="lp-title">Overlay</div>' +
      '<label class="lp-row"><input type="checkbox" id="layer-trails"' + (trailsOn() ? ' checked' : '') + '><span>Trail ratings (IMBA and S-scale)</span></label>' +
      '<label class="lp-row" title="Shown when the route is set to a gravel or mountain-bike level"><input type="checkbox" id="layer-dirt"' + (Settings.get('rlDirt') !== false ? ' checked' : '') + '><span>Dirt roads (gravel &amp; MTB)</span></label>';
  }

  function fillSelects() {
    const groups = {};
    for (const [k, v] of Object.entries(Router.TERRAIN)) (groups[v.group] = groups[v.group] || []).push('<option value="' + k + '">' + esc(v.name) + '</option>');
    $('route-profile').innerHTML = Object.entries(groups).map(([g, o]) => '<optgroup label="' + esc(g) + '">' + o.join('') + '</optgroup>').join('');
    const opts = Cues.CUSTOM.filter(t => t !== 'power').map(t => '<option value="' + t + '">' + esc(Cues.TYPES[t].name) + '</option>').join('');
    $('cue-type').innerHTML = opts;
    $('ser-type').innerHTML = ['eat', 'drink', 'note'].map(t => '<option value="' + t + '">' + esc(Cues.TYPES[t].name) + '</option>').join('');
    $('cue-kind').innerHTML =
      '<button data-kind="one" class="active">One cue</button>' +
      '<button data-kind="series">Repeating</button>' +
      '<button data-kind="power">Power target</button>';
    $('cue-label').placeholder = Cues.TYPES[$('cue-type').value].name;
    $('ser-label').placeholder = Cues.TYPES[$('ser-type').value].name;
  }

  function applyUnits() {
    document.querySelectorAll('.unit-label').forEach(el => { el.textContent = Units.label(units()); });
    const per = units() === 'mi' ? 'mi' : 'km';
    if (per === 'mi') { $('ser-every').value = 12; $('ser-from').value = 10; }
    else { $('ser-every').value = 20; $('ser-from').value = 15; }
    rebuild();
  }

  // ── Edits ─────────────────────────────────────────────────────────────────

  function snapshotOf(r) {
    return { name: r.name, profile: r.profile, waypoints: r.waypoints.map(w => ({ ...w })), legs: r.legs.slice(), cues: r.cues.map(c => ({ ...c })) };
  }
  function snapshot() {
    state.undo.push(snapshotOf(state.route));
    if (state.undo.length > 60) state.undo.shift();
    state.redo = [];
  }
  function restore(s) {
    Object.assign(state.route, { name: s.name, profile: s.profile, waypoints: s.waypoints, legs: s.legs, cues: s.cues });
    state.selectedWp = null;
    ensureRouted();
    changed();
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshotOf(state.route));
    restore(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshotOf(state.route));
    restore(state.redo.pop());
  }

  function pendingLeg(a, b) {
    return { coords: [[a.lat, a.lon, null], [b.lat, b.lon, null]], hints: [], kind: 'pending' };
  }

  /** Ask the router for every leg still pending. Results land only if the leg is still there. */
  function ensureRouted() {
    const r = state.route;
    r.legs.forEach((leg, k) => {
      if (leg.kind !== 'pending' || state.inflight.has(leg)) return;
      const a = r.waypoints[k], b = r.waypoints[k + 1];
      state.inflight.add(leg);
      renderRouting();
      const profileNow = r.profile;
      Router.leg(a, b, profileNow).then(res => {
        const at = state.route.legs.indexOf(leg);
        if (at >= 0) {
          state.route.legs[at] = res; replaceInSnapshots(leg, res); changed({ quiet: true });
          if (res.fallback) say('route-status', 'warn', 'The router would not take RouteLab’s profile, so this leg used BRouter’s standard one — it may use a sidewalk. Change the terrain to try again.');
        }
      }, err => {
        const at = state.route.legs.indexOf(leg);
        if (at >= 0) {
          say('route-status', 'err', err.message + ' Drawn as a straight line for now.');
          Router.straight(a, b).then(s => {
            const k2 = state.route.legs.indexOf(leg);
            if (k2 >= 0) { state.route.legs[k2] = s; replaceInSnapshots(leg, s); changed({ quiet: true }); }
          });
        }
      }).finally(() => { state.inflight.delete(leg); renderRouting(); });
    });
  }

  // An undo snapshot taken while a leg was routing should get the routed leg too.
  function replaceInSnapshots(old, now) {
    for (const s of state.undo.concat(state.redo)) {
      const i = s.legs.indexOf(old);
      if (i >= 0) s.legs[i] = now;
    }
  }

  function renderRouting() {
    const n = state.inflight.size;
    if (n) say('route-status', 'loading', 'Routing ' + n + ' leg' + (n > 1 ? 's' : '') + '…');
    else if (/Routing/.test($('route-status').textContent)) say('route-status', '', '');
  }

  function addWaypoint(lat, lon) {
    snapshot();
    const r = state.route;
    const w = { lat, lon };
    if (r.waypoints.length) r.legs.push(pendingLeg(r.waypoints[r.waypoints.length - 1], w));
    r.waypoints.push(w);
    changed();
    ensureRouted();
  }

  function insertWaypoint(k, w) {
    // Splits leg k into k (a → w) and k+1 (w → b).
    const r = state.route;
    r.waypoints.splice(k + 1, 0, w);
    r.legs.splice(k, 1, pendingLeg(r.waypoints[k], w), pendingLeg(w, r.waypoints[k + 2]));
  }

  function moveWaypoint(i, w) {
    const r = state.route;
    r.waypoints[i] = w;
    if (i > 0) r.legs[i - 1] = pendingLeg(r.waypoints[i - 1], w);
    if (i < r.legs.length) r.legs[i] = pendingLeg(w, r.waypoints[i + 1]);
  }

  function removeWaypoint(i) {
    const r = state.route;
    if (i == null || i < 0 || i >= r.waypoints.length) return;
    snapshot();
    if (r.waypoints.length === 1) { r.waypoints = []; r.legs = []; }
    else if (i === 0) { r.waypoints.shift(); r.legs.shift(); }
    else if (i === r.waypoints.length - 1) { r.waypoints.pop(); r.legs.pop(); }
    else {
      r.waypoints.splice(i, 1);
      r.legs.splice(i - 1, 2, pendingLeg(r.waypoints[i - 1], r.waypoints[i]));
    }
    selectWp(null);
    changed();
    ensureRouted();
  }

  function setProfile(p) {
    const r = state.route;
    p = Router.terrainKey(p);
    if (p === r.profile) return;
    snapshot();
    r.profile = p;
    Settings.set({ rlProfile: p });
    requestTrails();
    // Re-route what the router drew; an imported track keeps its exact line.
    let n = 0;
    r.legs = r.legs.map((leg, k) => {
      if (leg.kind === 'track') return leg;
      n++;
      return pendingLeg(r.waypoints[k], r.waypoints[k + 1]);
    });
    changed();
    ensureRouted();
    if (n) say('route-status', 'info', 'Re-routing ' + n + ' leg' + (n > 1 ? 's' : '') + ' as ' + Router.PROFILES[p].toLowerCase() + '.');
  }

  function closeLoop() {
    const r = state.route;
    if (r.waypoints.length < 2) { say('route-status', 'warn', 'Add at least two points first.'); return; }
    const a = r.waypoints[0];
    addWaypoint(a.lat, a.lon);
  }

  /** A leg ridden the other way: geometry reversed, turn hints mirrored. */
  function reverseLeg(leg) {
    const n = leg.coords.length;
    const flip = { 2: 5, 3: 6, 4: 7, 5: 2, 6: 3, 7: 4, 8: 9, 9: 8, 10: 11, 11: 10, 17: 18, 18: 17 };
    return {
      kind: leg.kind,
      ...(leg.surface ? { surface: { ...leg.surface, ...(leg.surface.runs ? { runs: leg.surface.runs.slice().reverse() } : {}) } } : {}),
      coords: leg.coords.slice().reverse().map(c => c.slice()),
      hints: (leg.hints || []).map(h => [n - 1 - h[0], flip[h[1]] || h[1], 0, h[3], -h[4]]).reverse(),
    };
  }

  function outAndBack() {
    const r = state.route;
    if (r.waypoints.length < 2 || r.legs.some(l => l.kind === 'pending')) {
      say('route-status', 'warn', r.waypoints.length < 2 ? 'Add at least two points first.' : 'Wait for the route to finish routing.');
      return;
    }
    snapshot();
    const back = r.legs.slice().reverse().map(reverseLeg);
    const wps = r.waypoints.slice(0, -1).reverse().map(w => ({ ...w }));
    r.waypoints = r.waypoints.concat(wps);
    r.legs = r.legs.concat(back);
    changed();
  }

  function reverse() {
    const r = state.route;
    if (r.waypoints.length < 2) return;
    if (r.legs.some(l => l.kind === 'pending')) { say('route-status', 'warn', 'Wait for the route to finish routing.'); return; }
    snapshot();
    const L = state.track.length;
    r.waypoints = r.waypoints.slice().reverse();
    r.legs = r.legs.slice().reverse().map(reverseLeg);
    // Places move with the road; a repeating series stays "every N km from the start".
    r.cues = r.cues.map(c => {
      if (c.series) return c;
      if (c.type === 'power') {
        const end = c.endM || L;
        return { ...c, atM: Math.max(0, L - end), endM: c.endM ? L - c.atM : (c.atM > 0 ? L - c.atM : null) };
      }
      return { ...c, atM: Math.max(0, L - c.atM) };
    });
    changed();
  }

  /** After any edit: rebuild, render, save soon. */
  function changed({ quiet = false } = {}) {
    state.route.updated = Date.now();
    rebuild();
    scheduleSave();
    if (!quiet) selectWp(state.selectedWp);
  }

  function rebuild() {
    const r = state.route;
    state.track = RouteStore.build(r);
    const s = Settings.all();
    state.times = Cues.timing(r, state.track, {
      mass: s.mass, cda: s.cda, crr: s.crr, ftp: s.ftp, ridePct: s.rlRidePct, maxDescent: s.rlMaxDescent,
    });
    state.cues = Cues.all(r, state.track, { turns: true, slight: !!s.rlSlightTurns });
    matchTrails({ render: false });
    render();
    requestTrails();
  }

  /** Which rated trails the route rides, from whatever ratings are loaded. */
  function matchTrails({ render: again = true } = {}) {
    const before = JSON.stringify((state.trailRuns || []).map(x => [x.way.id, Math.round(x.fromM)]));
    state.trailRuns = trailsOn() && !state.drag ? Trails.match(state.track) : [];
    const after = JSON.stringify(state.trailRuns.map(x => [x.way.id, Math.round(x.fromM)]));
    if (again && before !== after) { renderStats(); profile.draw(profileState()); }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  async function save() {
    const r = state.route;
    if (r.legs.some(l => l.kind === 'pending')) { scheduleSave(); return; }
    if (!r.waypoints.length && !r.id) return;
    const plain = RouteStore.toPlain(r);
    try {
      await RouteStore.put(plain);
      r.id = plain.id;
      Local.setCurrent(r.id);
      const i = state.saved.findIndex(x => x.id === r.id);
      if (i >= 0) state.saved[i] = plain; else state.saved.unshift(plain);
      state.saved.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      renderList();
    } catch (_) { /* no IndexedDB: the route still works, it just won't be kept */ }
  }

  function openRoute(saved, { fit: doFit = true } = {}) {
    const r = RouteStore.fromJson(saved) || RouteStore.blank();
    r.id = saved.id; r.created = saved.created || Date.now(); r.updated = saved.updated || Date.now();
    state.route = r;
    state.undo = []; state.redo = [];
    state.selectedWp = null;
    Local.setCurrent(r.id);
    rebuild();
    ensureRouted();
    if (doFit) fit();
  }

  async function newRoute() {
    clearTimeout(saveTimer);
    await save();
    state.route = RouteStore.blank();
    state.undo = []; state.redo = [];
    state.selectedWp = null;
    Local.setCurrent(null);
    rebuild();
    renderList();
    say('route-status', 'info', 'New route — click the map to start.');
  }

  async function adopt(r, { message } = {}) {
    clearTimeout(saveTimer);
    if (state.route.waypoints.length) await save();
    state.route = r;
    state.undo = []; state.redo = [];
    state.selectedWp = null;
    rebuild();
    fit();
    await save();
    if (message) say('route-status', 'ok', message);
  }

  async function listClick(e) {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.ride-del')) {
      const r = state.saved.find(x => x.id === id);
      if (!confirm('Delete "' + (r ? r.name : 'this route') + '"? This cannot be undone.')) return;
      try { await RouteStore.remove(id); } catch (_) {}
      state.saved = state.saved.filter(x => x.id !== id);
      if (state.route.id === id) { state.route = RouteStore.blank(); Local.setCurrent(null); rebuild(); }
      renderList();
      return;
    }
    if (id === state.route.id) return;
    clearTimeout(saveTimer);
    if (state.route.waypoints.length) await save();
    const r = state.saved.find(x => x.id === id);
    if (r) openRoute(r);
    renderList();
  }

  function saveView(v) {
    clearTimeout(saveView.t);
    saveView.t = setTimeout(() => Local.setView({ lat: round6(v.lat), lon: round6(v.lon), z: Math.round(v.z * 4) / 4 }), 500);
  }
  function round6(x) { return Math.round(x * 1e6) / 1e6; }

  // ── Import ────────────────────────────────────────────────────────────────

  async function importFile(file) {
    const name = file.name.replace(/\.[^.]+$/, '');
    setBusy(true, 'Reading ' + file.name + '…');
    try {
      let rows = [], marks = [], title = name, route = null;
      if (/\.fit$/i.test(file.name)) {
        const raw = Fit.parse(await file.arrayBuffer(), file.name);
        rows = rideRows(raw);
        title = raw.name || name;
      } else {
        const text = await file.text();
        if (/\.json$/i.test(file.name)) {
          const json = JSON.parse(text);
          route = RouteStore.fromJson(json);
          if (!route && json && Array.isArray(json.lat)) rows = rideRows(json);
          else if (!route) throw new Error('That JSON is not a RouteLab route or a ride export.');
          title = (json && json.name) || name;
        } else {
          const g = Gpx.parse(text);
          rows = g.rows; marks = g.marks; title = g.name || name;
        }
      }
      if (route) { await adopt(route, { message: 'Loaded ' + route.name + '.' }); return; }
      await adopt(await trackRoute(rows, title, marks, 'file'), {
        message: 'Imported ' + title + (marks.length ? ' with ' + marks.length + ' cue' + (marks.length > 1 ? 's' : '') : '') + '.',
      });
    } catch (err) {
      say('route-status', 'err', 'Could not import ' + file.name + ': ' + (err.message || err));
    } finally {
      setBusy(false);
    }
  }

  function rideRows(raw) {
    const out = [];
    for (let i = 0; i < (raw.lat || []).length; i++) {
      const la = raw.lat[i], lo = raw.lon[i];
      if (la == null || lo == null || !isFinite(la) || !isFinite(lo) || (la === 0 && lo === 0)) continue;
      const e = raw.alt && raw.alt[i];
      out.push([la, lo, e != null && isFinite(e) ? e : null]);
    }
    return out;
  }

  /** A fixed track as a route: one leg between its ends, exactly as drawn. */
  async function trackRoute(rows, title, marks, source) {
    if (rows.length < 2) throw new Error('No track points with a position in it.');
    // A 1 Hz ride is thousands of points metres apart; 2 m of tolerance keeps the shape.
    let pts = rows.length > 3000 ? Geo.simplify(rows, 2) : rows.slice();
    if (pts.filter(p => p[2] != null).length < pts.length / 2) {
      setBusy(true, 'Looking up elevation…');
      try { await fillElevation(pts); } catch (_) { /* a flat profile is still a route */ }
    }
    const r = RouteStore.blank(title);
    r.source = source;
    r.waypoints = [{ lat: pts[0][0], lon: pts[0][1] }, { lat: pts[pts.length - 1][0], lon: pts[pts.length - 1][1] }];
    r.legs = [{ coords: pts, hints: [], kind: 'track' }];
    const t = RouteStore.build(r);
    r.cues = (marks || []).map(m => {
      const i = RouteStore.nearest(t, m.lat, m.lon);
      const type = Gpx.cueType(m);
      return Cues.make(type, t.d[i], { label: m.name || Cues.TYPES[type].name, note: m.desc || '' });
    });
    return r;
  }

  /** Elevation for a long track: look up one point per ~100 m and interpolate between. */
  async function fillElevation(pts) {
    const idx = [0];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += Geo.dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (acc >= 100 || i === pts.length - 1) { idx.push(i); acc = 0; }
    }
    const step = Math.ceil(idx.length / 1000);
    const pick = idx.filter((_, k) => k % step === 0 || k === idx.length - 1);
    const sub = pick.map(i => [pts[i][0], pts[i][1], null]);
    await Router.elevate(sub);
    const e = new Float64Array(pts.length).fill(NaN);
    pick.forEach((i, k) => { if (sub[k][2] != null) e[i] = sub[k][2]; });
    RouteStore.fillGaps(e);
    for (let i = 0; i < pts.length; i++) if (isFinite(e[i])) pts[i] = [pts[i][0], pts[i][1], round1(e[i])];
  }

  async function loadSample() {
    setBusy(true, 'Loading the sample route…');
    try {
      const url = location.pathname.replace(/[^/]*$/, '') + 'assets/data/sample-route.json';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const r = RouteStore.fromJson({ ...json, legs: json.legs.map(l => ({ ...l, kind: 'route' })) });
      r.source = 'sample';
      const t = RouteStore.build(r);
      const ftp = Settings.get('ftp') || 250;
      r.cues = [
        ...Cues.series('eat', { everyM: 20000, fromM: 15000, toM: t.length - 5000, label: 'Eat' }),
        ...Cues.series('drink', { everyM: 10000, fromM: 10000, toM: t.length - 3000, label: 'Drink' }),
        ...Cues.climbs(t).map(c => Cues.power(c.fromM, c.toM, Math.round(ftp * 0.88), ftp)),
      ];
      await adopt(r, { message: 'Sample loaded: eat every 20 km, drink every 10 km, 88% FTP on each climb.' });
    } catch (err) {
      say('route-status', 'err', 'Could not load the sample route (' + (err.message || err) + ').');
    } finally {
      setBusy(false);
    }
  }

  // ── intervals.icu ─────────────────────────────────────────────────────────

  function renderIcuConnection() {
    const on = !!Settings.get('icuKey');
    $('icu-connect').style.display = on ? 'none' : '';
    $('icu-panel').style.display = on ? '' : 'none';
    const name = Settings.get('icuAthleteName');
    $('icu-who').innerHTML = on
      ? 'Connected' + (name ? ' as ' + esc(name) : '') + ' · <a href="' + connectUrl() + '">change</a>'
      : '';
  }

  async function icuList() {
    const key = Settings.get('icuKey');
    const box = $('icu-results');
    if (!key) { box.innerHTML = '<div class="status status-warn">Not connected — use Connect intervals.icu.</div>'; return; }
    box.innerHTML = '<div class="status status-info status-loading">Fetching your rides…</div>';
    try {
      const today = new Date(), from = new Date(Date.now() - 120 * 86400e3);
      const iso = d => d.toISOString().slice(0, 10);
      const list = (await Intervals.listActivities({ key, athleteId: Settings.get('icuAthlete') || '0', oldest: iso(from), newest: iso(today) }))
        .filter(a => Intervals.isRide({ type: a.type }) && a.hasGpsStream && !a.trainer)
        .sort((a, b) => String(b.start).localeCompare(String(a.start)));
      if (!list.length) { box.innerHTML = '<p class="hint">No outdoor rides with GPS in the last 120 days.</p>'; return; }
      box.innerHTML = list.slice(0, 60).map(a =>
        '<div class="ride-item" data-icu="' + esc(a.id) + '"><div class="ride-swatch"></div><div class="ride-body">' +
        '<div class="ride-name">' + esc(a.name) + '</div>' +
        '<div class="ride-meta">' + esc(String(a.start || '').slice(0, 10)) + (a.distance ? ' · ' + fmt(a.distance) : '') +
        (a.apiBlocked ? ' · <span class="ride-warn">from Strava, unreadable</span>' : '') + '</div></div></div>').join('');
      box.querySelectorAll('[data-icu]').forEach(el => el.addEventListener('click', () => icuTrace(el.dataset.icu, list)));
    } catch (err) {
      box.innerHTML = '<div class="status status-err">' + esc(err.message || err) + '</div>';
    }
  }

  async function icuTrace(id, list) {
    const a = list.find(x => String(x.id) === String(id));
    setBusy(true, 'Downloading from intervals.icu…');
    try {
      const raw = await Intervals.loadRide(id, Settings.get('icuKey'));
      const rows = rideRows(raw);
      await adopt(await trackRoute(rows, (a && a.name) || raw.name, [], 'icu'), { message: 'Traced ' + raw.name + '. Add points past its end to extend it.' });
    } catch (err) {
      $('icu-results').insertAdjacentHTML('afterbegin', '<div class="status status-err">' + esc(err.message || err) + '</div>');
    } finally {
      setBusy(false);
    }
  }

  async function icuFtp() {
    const key = Settings.get('icuKey');
    if (!key) return;
    try {
      const a = await Intervals.testKey(key, Settings.get('icuAthlete') || '0');
      const patch = {};
      if (a.ftp) { patch.ftp = a.ftp; patch.ftpUserSet = true; }
      if (a.weight) patch.mass = Math.round((a.weight + 9) * 10) / 10;
      Settings.set(patch);
      rebuild();
      say('cue-status', a.ftp ? 'ok' : 'warn', a.ftp ? 'FTP ' + a.ftp + ' W from intervals.icu' + (a.weight ? ', ' + a.weight.toFixed(1) + ' kg + 9 kg of bike' : '') + '.' : 'intervals.icu has no FTP set for rides.');
    } catch (err) {
      say('cue-status', 'err', err.message || String(err));
    }
  }

  // ── Map interaction ───────────────────────────────────────────────────────

  function hitTest(x, y) {
    if (!screen) return null;
    const r = state.route;
    for (let i = r.waypoints.length - 1; i >= 0; i--) {
      const p = map.project(r.waypoints[i].lat, r.waypoints[i].lon);
      if (Math.hypot(p.x - x, p.y - y) <= 10) return { kind: 'wp', i };
    }
    for (const c of screen.cues) {
      if (Math.hypot(c.x - x, c.y - y) <= 9) return { kind: 'cue', id: c.id };
    }
    if (state.pick) return null;
    let best = 8, bi = -1;
    const P = screen.pts;
    for (let i = 1; i < P.length; i++) {
      const d = segDist(x, y, P[i - 1], P[i]);
      if (d < best) { best = d; bi = i - 1; }
    }
    if (bi >= 0) return { kind: 'line', i: screen.idx[bi] };
    return null;
  }

  function segDist(x, y, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    let t = L ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
  }

  function mapClick(e) {
    if (state.pick) {
      if (state.track.n < 2) { setPick(null); return; }
      const i = RouteStore.nearest(state.track, e.lat, e.lon);
      pickDistance(state.track.d[i]);
      return;
    }
    if (e.hit && e.hit.kind === 'wp') { selectWp(state.selectedWp === e.hit.i ? null : e.hit.i); return; }
    if (e.hit && e.hit.kind === 'cue') {
      const tr = document.querySelector('#cue-rows tr[data-id="' + e.hit.id + '"]');
      if (tr) { tr.scrollIntoView({ block: 'nearest' }); flash(tr); }
      return;
    }
    if (state.selectedWp != null) { selectWp(null); return; }
    addWaypoint(round6(e.lat), round6(e.lon));
  }

  function dragStart(hit) {
    if (hit.kind === 'cue') {
      const c = state.route.cues.find(x => x.id === hit.id || x.id + '-end' === hit.id);
      if (!c) return;
      snapshot();
      state.drag = { kind: 'cue', cue: c, end: hit.id.endsWith('-end') };
      return;
    }
    snapshot();
    if (hit.kind === 'line') {
      const k = RouteStore.legOf(state.track, hit.i);
      const w = { lat: state.track.lat[hit.i], lon: state.track.lon[hit.i] };
      insertWaypoint(k, w);
      state.drag = { kind: 'wp', i: k + 1 };
    } else {
      state.drag = { kind: 'wp', i: hit.i };
    }
    selectWp(null);
    rebuild();
  }

  function dragMove(hit, e) {
    const d = state.drag;
    if (!d) return;
    if (d.kind === 'cue') {
      const i = RouteStore.nearest(state.track, e.lat, e.lon);
      if (d.end) d.cue.endM = Math.max(d.cue.atM + 10, state.track.d[i]);
      else {
        const len = d.cue.endM ? d.cue.endM - d.cue.atM : 0;
        d.cue.atM = state.track.d[i];
        if (len) d.cue.endM = Math.min(state.track.length, d.cue.atM + len);
      }
      delete d.cue.series;   // moved by hand: no longer part of the even series
      rebuild();
      return;
    }
    moveWaypoint(d.i, { lat: round6(e.lat), lon: round6(e.lon) });
    rebuild();
  }

  function dragEnd() {
    const d = state.drag;
    state.drag = null;
    if (!d) return;
    changed();
    ensureRouted();
  }

  function mapHover(e) {
    showTip(e && !state.drag ? e : null);
    if (!e || !state.track || state.track.n < 2) { if (state.hoverM != null) { state.hoverM = null; profile.setHover(null); map.redraw(); } return; }
    const hit = hitTest(e.x, e.y);
    map.canvas.style.cursor = state.pick ? 'crosshair' : hit ? (hit.kind === 'line' ? 'copy' : 'grab') : '';
    if (hit && hit.kind === 'line') {
      state.hoverM = state.track.d[hit.i];
      profile.setHover(state.hoverM);
      map.redraw();
    } else if (state.hoverM != null) {
      state.hoverM = null; profile.setHover(null); map.redraw();
    }
  }

  function selectWp(i) {
    const r = state.route;
    state.selectedWp = i != null && i < r.waypoints.length ? i : null;
    const bar = $('wp-bar');
    if (state.selectedWp == null) { bar.hidden = true; map.redraw(); return; }
    const n = r.waypoints.length;
    const what = state.selectedWp === 0 ? 'Start' : state.selectedWp === n - 1 ? 'Finish' : 'Point ' + (state.selectedWp + 1) + ' of ' + n;
    bar.innerHTML = '<span>' + what + '</span>' +
      '<button class="btn btn-sm" id="wp-remove">Remove</button>' +
      '<button class="btn btn-sm" id="wp-cancel">Done</button>';
    bar.hidden = false;
    $('wp-remove').addEventListener('click', () => removeWaypoint(state.selectedWp));
    $('wp-cancel').addEventListener('click', () => selectWp(null));
    map.redraw();
  }

  function setPick(mode) {
    state.pick = mode;
    const el = $('map-mode');
    if (mode) {
      el.textContent = 'Click the route to choose ' + (mode === 'pw-to' ? 'where the target ends' : mode === 'pw-from' ? 'where the target starts' : 'where the cue goes') + ' · Esc to cancel';
      el.hidden = false;
      if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
        document.querySelector('.mobile-tab[data-mpanel="map"]').click();
      }
    } else el.hidden = true;
    ['cue-pick', 'pw-pick', 'pw-pick-to'].forEach(id => $(id).classList.toggle('active', (
      (id === 'cue-pick' && mode === 'cue') || (id === 'pw-pick' && mode === 'pw-from') || (id === 'pw-pick-to' && mode === 'pw-to'))));
  }

  /** A distance chosen on the map or the profile goes to whichever field is asking. */
  function pickDistance(m) {
    const v = round1(fromM(m));
    if (state.pick === 'pw-from' || (!state.pick && state.kind === 'power')) $('pw-from').value = v;
    else if (state.pick === 'pw-to') $('pw-to').value = v;
    else if (state.pick === 'cue' || state.kind === 'one') $('cue-at').value = v;
    else if (state.kind === 'series') $('ser-from').value = v;
    if (state.pick === 'pw-from') setPick('pw-to');
    else setPick(null);
    previews();
    if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches && !state.pick) {
      document.querySelector('.mobile-tab[data-mpanel="cues"]').click();
    }
  }

  function fit() {
    const t = state.track;
    if (!t || !t.n) return;
    let s = 90, n = -90, w = 180, e = -180;
    for (let i = 0; i < t.n; i++) {
      if (t.lat[i] < s) s = t.lat[i]; if (t.lat[i] > n) n = t.lat[i];
      if (t.lon[i] < w) w = t.lon[i]; if (t.lon[i] > e) e = t.lon[i];
    }
    if (t.n === 1) { map.setView(t.lat[0], t.lon[0], 14); return; }
    map.fitBounds(s, w, n, e);
  }

  function locate() {
    if (!navigator.geolocation) { say('route-status', 'warn', 'This browser cannot share its location.'); return; }
    navigator.geolocation.getCurrentPosition(
      p => map.setView(p.coords.latitude, p.coords.longitude, 13),
      () => say('route-status', 'warn', 'Location not available — search for a place instead.'),
      { timeout: 10000, maximumAge: 600000 });
  }

  async function search(q) {
    const box = $('search-results');
    q = String(q || '').trim();
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="search-row status-loading">Searching…</div>';
    try {
      const rows = await Router.geocode(q);
      if (!rows.length) { box.innerHTML = '<div class="search-row hint">Nothing found.</div>'; return; }
      box.innerHTML = rows.map((r, k) => '<button class="search-row" data-k="' + k + '">' + esc(r.name) + '</button>').join('');
      box.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => {
        const r = rows[+b.dataset.k];
        if (r.bbox) map.fitBounds(r.bbox[0], r.bbox[2], r.bbox[1], r.bbox[3]);
        else map.setView(r.lat, r.lon, 13);
        box.hidden = true;
      }));
    } catch (err) {
      box.innerHTML = '<div class="search-row hint">' + esc(err.message || err) + '</div>';
    }
  }

  // ── Map overlay ───────────────────────────────────────────────────────────

  const ROUTE = '#e0317e';          // magenta: distinct from CyclOSM's blue lanes and the trail colours
  const POWER = '#f76707';
  const DIRT = '#8a4b14';           // brown: dirt roads on the map, and stripes on the route where it is unpaved
  const DIRT_TRAIL = '#4a2a0c';

  function drawOverlay(ctx, m) {
    const t = state.track, r = state.route;
    screen = { pts: [], idx: [], cues: [], trails: [] };
    drawDirt(ctx, m);
    drawTrails(ctx, m);
    if (!t) return;
    // Decimate to roughly a point per pixel for drawing and hit-testing.
    let last = null;
    for (let i = 0; i < t.n; i++) {
      const p = m.project(t.lat[i], t.lon[i]);
      if (last && i < t.n - 1 && Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 1.5) continue;
      screen.pts.push(p); screen.idx.push(i); last = p;
    }
    const P = screen.pts;
    const line = (from, to, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < P.length; k++) {
        const i = screen.idx[k];
        if (i < from || i > to) continue;
        if (!started) { ctx.moveTo(P[k].x, P[k].y); started = true; } else ctx.lineTo(P[k].x, P[k].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (P.length > 1) {
      // A hairline of shadow, then white, then the colour: reads on any basemap.
      line(0, t.n, 'rgba(0, 0, 0, 0.28)', 10);
      line(0, t.n, '#ffffff', 8);
      r.legs.forEach((leg, k) => {
        const a = t.legStart[k], b = k + 1 < t.legStart.length ? t.legStart[k + 1] : t.n - 1;
        line(a, b, leg.kind === 'pending' ? 'rgba(224, 49, 126, 0.55)' : ROUTE, 4.5, leg.kind === 'pending' ? [7, 7] : null);
      });
      // Unpaved stretches, striped brown over the route colour (gravel and MTB levels).
      if (dirtMode() && t.dirt) {
        for (const sp of t.dirt) {
          const [a, b] = indexSpan(t, sp.fromM, sp.toM);
          if (b > a) line(a, b, sp.kind === 'trail' ? DIRT_TRAIL : DIRT, 4.5, [7, 6]);
        }
      }
      for (const c of r.cues) {
        if (c.type !== 'power') continue;
        const end = c.endM || t.length;
        let a = 0, b = t.n - 1;
        while (a < t.n - 1 && t.d[a] < c.atM) a++;
        while (b > 0 && t.d[b] > end) b--;
        if (b > a) line(a, b, POWER, 4.5);
      }
      chevrons(ctx, P);
      kmMarkers(ctx, m, t);
    }

    // Cues: white-ringed discs, so they read on the light basemap.
    const showTurns = !!Settings.get('rlShowTurns');
    for (const c of state.cues) {
      const ty = Cues.TYPES[c.type];
      if (ty.turn && !showTurns) continue;
      const p = RouteStore.positionAt(t, c.atM);
      if (!p) continue;
      const q = m.project(p.lat, p.lon);
      screen.cues.push({ id: c.id, x: q.x, y: q.y, cue: c });
      const rad = ty.turn ? 6.5 : 9;
      ctx.fillStyle = ty.turn ? '#24292f' : ty.color;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = ty.turn ? '#ffffff' : '#0d1117';
      ctx.font = 'bold ' + (ty.turn ? 9 : 10) + 'px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ty.glyph, q.x, q.y + 0.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }

    // Where a point was put somewhere the route can't go (a field, a trail
    // closed to bikes), a dashed line shows where it actually joins.
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(36, 41, 47, 0.75)'; ctx.lineWidth = 1.5;
    r.waypoints.forEach((w, i) => {
      const leg = i > 0 ? r.legs[i - 1] : r.legs[0];
      if (!leg || leg.kind === 'pending' || !leg.coords.length) return;
      const c = i > 0 ? leg.coords[leg.coords.length - 1] : leg.coords[0];
      const p = m.project(w.lat, w.lon), q = m.project(c[0], c[1]);
      if (Math.hypot(p.x - q.x, p.y - q.y) < 12) return;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    });
    ctx.setLineDash([]);

    // Waypoints: a start disc, a chequered finish, small rings between.
    r.waypoints.forEach((w, i) => {
      const p = m.project(w.lat, w.lon);
      const first = i === 0, lastWp = i === r.waypoints.length - 1 && i > 0;
      const loop = lastWp && Geo.dist(w.lat, w.lon, r.waypoints[0].lat, r.waypoints[0].lon) < 15;
      if (loop) return;   // the start marker already says "here"
      if (first) startMarker(ctx, p.x, p.y);
      else if (lastWp) finishMarker(ctx, p.x, p.y);
      else {
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = ROUTE; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (i === state.selectedWp) {
        ctx.strokeStyle = '#1c6fd6'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.stroke();
      }
    });

    // Where the profile is pointing.
    if (state.hoverM != null && t.n > 1) {
      const p = RouteStore.positionAt(t, state.hoverM);
      const q = m.project(p.lat, p.lon);
      ctx.fillStyle = '#fab219'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function chevrons(ctx, P) {
    ctx.fillStyle = '#ffffff';
    let acc = 0;
    for (let k = 1; k < P.length; k++) {
      const seg = Math.hypot(P[k].x - P[k - 1].x, P[k].y - P[k - 1].y);
      acc += seg;
      if (acc < 110 || seg < 0.5) continue;
      acc = 0;
      const ang = Math.atan2(P[k].y - P[k - 1].y, P[k].x - P[k - 1].x);
      ctx.save(); ctx.translate(P[k].x, P[k].y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(3.5, 0); ctx.lineTo(-2.5, -3.2); ctx.lineTo(-1, 0); ctx.lineTo(-2.5, 3.2); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  /** Distance pills along the route, at a round step that keeps them ~90 px apart. */
  function kmMarkers(ctx, m, t) {
    const per = units() === 'mi' ? Units.MI : 1000;
    const a = m.project(t.lat[0], t.lon[0]);
    let px = 0, prev = a;
    for (let k = 1; k < screen.pts.length; k++) { px += Math.hypot(screen.pts[k].x - prev.x, screen.pts[k].y - prev.y); prev = screen.pts[k]; }
    const pxPerM = px / Math.max(1, t.length);
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find(s => s * per * pxPerM >= 90);
    if (!step) return;
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let v = step; v * per < t.length - step * per * 0.3; v += step) {
      const p = RouteStore.positionAt(t, v * per);
      const q = m.project(p.lat, p.lon);
      if (q.x < -20 || q.y < -20 || q.x > m.width + 20 || q.y > m.height + 20) continue;
      const label = String(v), w = Math.max(18, label.length * 6 + 8);
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = ROUTE; ctx.lineWidth = 1.5;
      roundRect(ctx, q.x - w / 2, q.y - 8, w, 16, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#24292f';
      ctx.fillText(label, q.x, q.y + 0.5);
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function startMarker(ctx, x, y) {
    ctx.fillStyle = '#2f9e44'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(x - 2.5, y - 4.5); ctx.lineTo(x + 4.5, y); ctx.lineTo(x - 2.5, y + 4.5); ctx.closePath(); ctx.fill();
  }

  function finishMarker(ctx, x, y) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 9, y - 9, 18, 18);
    ctx.fillStyle = '#111111';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 0) ctx.fillRect(x - 9 + i * 4.5, y - 9 + j * 4.5, 4.5, 4.5);
    ctx.restore();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 10.5, 0, Math.PI * 2); ctx.stroke();
  }

  // ── Trail ratings ──────────────────────────────────────────────────────────

  const TRAIL_MIN_Z = 11;
  const DIRT_MIN_Z = 12;

  /** Track indices covering [fromM, toM]. */
  function indexSpan(t, fromM, toM) {
    let a = 0, b = t.n - 1;
    while (a < t.n - 1 && t.d[a + 1] <= fromM) a++;
    while (b > 0 && t.d[b - 1] >= toM) b--;
    return [a, b];
  }

  /** Dirt is highlighted only when the route is set to a gravel or MTB level. */
  function dirtMode() {
    const g = Router.terrain(state.route.profile).group;
    return g === 'Gravel' || g === 'Mountain bike';
  }
  function dirtOn() { return dirtMode() && Settings.get('rlDirt') !== false; }

  function drawDirt(ctx, m) {
    if (!dirtOn() || m.view().z < DIRT_MIN_Z) return;
    const b = m.bounds();
    const z = m.view().z;
    const w = z >= 15 ? 3.5 : z >= 13 ? 2.6 : 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    for (const way of Trails.dirt.waysIn(b.s, b.w, b.n, b.e)) {
      const pts = [];
      for (let k = 0; k + 1 < way.g.length; k += 2) pts.push(m.project(way.g[k], way.g[k + 1]));
      if (!pts.some(p => p.x > -50 && p.y > -50 && p.x < m.width + 50 && p.y < m.height + 50)) continue;
      const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
      path(); ctx.strokeStyle = 'rgba(255, 244, 214, 0.85)'; ctx.lineWidth = w + 2; ctx.stroke();
      // A road with a dirt surface solid; a track dashed, as on a topo map.
      path(); ctx.strokeStyle = DIRT; ctx.lineWidth = w; ctx.setLineDash(way.k === 'track' ? [6, 3] : []); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'round';
  }

  function trailsOn() { return Settings.get('rlTrails') !== false; }

  function drawTrails(ctx, m) {
    if (!trailsOn() || m.view().z < TRAIL_MIN_Z) return;
    const b = m.bounds();
    const ways = Trails.waysIn(b.s, b.w, b.n, b.e);
    const z = m.view().z;
    const w = z >= 15 ? 4 : z >= 13 ? 3 : 2.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // Hardest last, so a black diamond crossing a green circle shows on top.
    const rated = ways.map(way => ({ way, r: Trails.rate(way) })).filter(x => x.r)
      .sort((a, c) => Trails.ORDER.indexOf(a.r.key) - Trails.ORDER.indexOf(c.r.key));
    for (const { way, r } of rated) {
      const pts = [];
      for (let k = 0; k + 1 < way.g.length; k += 2) pts.push(m.project(way.g[k], way.g[k + 1]));
      if (!pts.some(p => p.x > -50 && p.y > -50 && p.x < m.width + 50 && p.y < m.height + 50)) continue;
      screen.trails.push({ way, r, pts });
      const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
      ctx.globalAlpha = way.b ? 0.45 : 1;
      path(); ctx.strokeStyle = r.key === 'white' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)'; ctx.lineWidth = w + 2.5; ctx.stroke();
      path(); ctx.strokeStyle = r.rating.color; ctx.lineWidth = w;
      ctx.setLineDash(way.b ? [5, 4] : []); ctx.stroke();
      if (r.key === 'double') {
        path(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, w / 3); ctx.setLineDash([3, 3]); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  let trailTimer = null;
  /** Ask for the ratings in view (and along the route), a moment after the map stops. */
  function requestTrails() {
    clearTimeout(trailTimer);
    trailTimer = setTimeout(() => {
      renderTrailLegend();
      if (!map) return;
      const b = map.bounds(), z = map.view().z;
      if (dirtOn()) Trails.dirt.want(z >= DIRT_MIN_Z ? Trails.tilesIn(b.s, b.w, b.n, b.e, 12) : []);
      if (!trailsOn()) return;
      Trails.want(z >= TRAIL_MIN_Z ? Trails.tilesIn(b.s, b.w, b.n, b.e, 12) : []);
      const t = state.track;
      if (t && t.n > 1 && t.length < 300000) {
        let s = 90, n = -90, w = 180, e = -180;
        for (let i = 0; i < t.n; i += 5) { s = Math.min(s, t.lat[i]); n = Math.max(n, t.lat[i]); w = Math.min(w, t.lon[i]); e = Math.max(e, t.lon[i]); }
        Trails.want(Trails.tilesIn(s, w, n, e, 16), { keep: true });
      }
    }, 350);
  }

  function renderTrailLegend() {
    const el = $('trail-legend');
    if (!el) return;
    const trails = trailsOn(), dirt = dirtOn();
    const routeDirt = dirtMode() && state.track && state.track.dirt && state.track.dirt.length > 0;
    if (!trails && !dirt && !routeDirt) { el.hidden = true; return; }
    el.hidden = false;
    const st = Trails.status(), ds = Trails.dirt.status();
    const z = map ? map.view().z : 99;
    const keys = ['green', 'blue', 'black', 'double', 'pro'];
    let html = '';
    if (trails) {
      html += '<div class="tl-title">Trail ratings</div>' +
        (z < TRAIL_MIN_Z ? '<div class="tl-note">Zoom in to see them</div>' :
          '<div class="tl-keys">' + keys.map(k => '<span class="tl-key"><i class="tl-sw tl-' + k + '"></i>' + esc(Trails.RATINGS[k].name.replace(' diamond', '').replace(' circle', '').replace(' square', '').replace('Double black', '◆◆')) + '</span>').join('') + '</div>');
    }
    if (dirt || routeDirt) {
      html += '<div class="tl-title' + (trails ? ' tl-gap' : '') + '">Dirt</div><div class="tl-keys">' +
        (dirt ? '<span class="tl-key"><i class="tl-sw tl-dirt-road"></i>Road</span><span class="tl-key"><i class="tl-sw tl-dirt-track"></i>Track</span>' : '') +
        (routeDirt ? '<span class="tl-key"><i class="tl-sw tl-dirt-route"></i>On your route</span>' : '') + '</div>' +
        (dirt && z < DIRT_MIN_Z ? '<div class="tl-note">Zoom in to see dirt roads</div>' : '');
    }
    const loading = (trails && st.loading) || (dirt && ds.loading);
    const failing = (trails && st.failing) || (dirt && ds.failing);
    const retryIn = Math.max(trails && st.failing ? st.retryIn : 0, dirt && ds.failing ? ds.retryIn : 0);
    html += loading ? '<div class="tl-note status-loading">Loading from OpenStreetMap…</div>'
      : failing ? '<div class="tl-note tl-warn">OpenStreetMap’s map-data service is busy; trying again' + (retryIn > 1 ? ' in ' + retryIn + ' s' : '') + '.</div>' : '';
    el.innerHTML = html;
  }


  /** The tooltip over the map for a trail or a cue under the pointer. */
  function showTip(e) {
    const tip = $('map-tip');
    if (!e) { tip.hidden = true; return; }
    let html = null;
    for (const c of screen ? screen.cues : []) {
      if (Math.hypot(c.x - e.x, c.y - e.y) <= 10) {
        const ty = Cues.TYPES[c.cue.type];
        html = '<b>' + esc(c.cue.label || ty.name) + '</b><span>' + esc(ty.name) + ' · ' + fmt(c.cue.atM) +
          (state.times ? ' · ' + Units.duration(Cues.timeAt(state.track, state.times, c.cue.atM)) : '') + '</span>' +
          (c.cue.note ? '<span>' + esc(c.cue.note) + '</span>' : '');
        break;
      }
    }
    if (!html && screen) {
      let best = 7, hit = null;
      for (const tr of screen.trails) for (let k = 1; k < tr.pts.length; k++) {
        const d = segDist(e.x, e.y, tr.pts[k - 1], tr.pts[k]);
        if (d < best) { best = d; hit = tr; }
      }
      if (hit) html = '<b>' + esc(hit.way.n || 'Unnamed trail') + '</b><span><i class="tl-sw tl-' + hit.r.key + '"></i>' + esc(hit.r.label) + '</span>' +
        (hit.way.b ? '<span class="tip-warn">Closed to bikes</span>' : '');
    }
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html;
    tip.hidden = false;
    const W = map.width;
    tip.style.left = Math.min(W - 230, e.x + 14) + 'px';
    tip.style.top = (e.y + 14) + 'px';
  }

  // ── Cue forms ─────────────────────────────────────────────────────────────

  function needTrack() {
    if (state.track && state.track.n > 1 && state.track.length > 0) return true;
    say('cue-status', 'warn', 'Draw or load a route first.');
    return false;
  }

  function addCues(list, msg) {
    snapshot();
    state.route.cues.push(...list);
    changed();
    say('cue-status', 'ok', msg);
  }

  function addOne() {
    if (!needTrack()) return;
    const type = $('cue-type').value;
    const at = toM($('cue-at').value || 0);
    if (!(at >= 0) || at > state.track.length + 1) { say('cue-status', 'err', 'That is past the end of the route (' + fmt(state.track.length) + ').'); return; }
    const label = $('cue-label').value.trim() || Cues.TYPES[type].name;
    addCues([Cues.make(type, at, { label, note: $('cue-note').value.trim() })], label + ' at ' + fmt(at) + '.');
    $('cue-label').value = ''; $('cue-note').value = '';
  }

  function seriesSpec() {
    const L = state.track ? state.track.length : 0;
    const everyM = toM($('ser-every').value || 0);
    const fromM_ = toM($('ser-from').value || 0);
    const toRaw = $('ser-to').value;
    const toM_ = toRaw === '' ? L : Math.min(L, toM(toRaw));
    return { everyM, fromM: fromM_, toM: toM_ };
  }

  function addSeries() {
    if (!needTrack()) return;
    const type = $('ser-type').value;
    const spec = seriesSpec();
    try {
      const label = $('ser-label').value.trim() || Cues.TYPES[type].name;
      const list = Cues.series(type, { ...spec, label });
      if (!list.length) { say('cue-status', 'warn', 'No cues fall inside that range.'); return; }
      addCues(list, list.length + ' × ' + label + ', every ' + fmt(spec.everyM) + '.');
    } catch (err) { say('cue-status', 'err', err.message); }
  }

  function powerWatts() {
    const v = +$('pw-watts').value || 0;
    return $('pw-unit').value === 'pct' ? v * (Settings.get('ftp') || 250) / 100 : v;
  }

  function addPower() {
    if (!needTrack()) return;
    const L = state.track.length;
    const a = toM($('pw-from').value || 0);
    const b = $('pw-to').value === '' ? L : Math.min(L, toM($('pw-to').value));
    const w = powerWatts();
    if (!(w > 0)) { say('cue-status', 'err', 'Give a target in watts or % of FTP.'); return; }
    if (!(b > a)) { say('cue-status', 'err', '"To" has to be after "From".'); return; }
    const c = Cues.power(a, b >= L - 1 ? null : b, w, Settings.get('ftp'));
    addCues([c], c.note + ', from ' + fmt(a) + '.');
  }

  function addClimbPower() {
    if (!needTrack()) return;
    const list = Cues.climbs(state.track);
    if (!list.length) { say('cue-status', 'warn', state.track.hasEle ? 'No climbs of 2 km at 3% or more on this route.' : 'This route has no elevation, so no climbs to find.'); return; }
    const w = powerWatts();
    if (!(w > 0)) { say('cue-status', 'err', 'Give a target in watts or % of FTP.'); return; }
    // Replace any existing target that starts inside one of these climbs rather than stacking two.
    const ftp = Settings.get('ftp');
    snapshot();
    state.route.cues = state.route.cues.filter(c => !(c.type === 'power' && list.some(k => c.atM >= k.fromM - 50 && c.atM <= k.toM)));
    state.route.cues.push(...list.map(k => Cues.power(k.fromM, k.toM, w, ftp)));
    changed();
    say('cue-status', 'ok', Math.round(w) + ' W on ' + list.length + ' climb' + (list.length > 1 ? 's' : '') + ': ' +
      list.map(k => fmt(k.fromM) + ' (' + (k.grade * 100).toFixed(1) + '%)').join(', ') + '.');
  }

  function previews() {
    const L = state.track ? state.track.length : 0;
    if (state.kind === 'series' && L > 0) {
      const s = seriesSpec();
      if (s.everyM > 0 && s.toM > s.fromM) {
        const n = Math.floor((s.toM - s.fromM) / s.everyM + 1e-9) + 1;
        const first = [0, 1, 2].map(k => s.fromM + k * s.everyM).filter(m => m <= s.toM);
        const eta = state.times ? ' · roughly every ' + Units.duration(Cues.timeAt(state.track, state.times, Math.min(L, s.fromM + s.everyM)) - Cues.timeAt(state.track, state.times, s.fromM)) : '';
        $('ser-preview').textContent = n + ' cue' + (n > 1 ? 's' : '') + ' at ' + first.map(m => round1(fromM(m))).join(', ') + (n > 3 ? ' …' : '') + ' ' + Units.label(units()) + eta;
      } else $('ser-preview').textContent = '';
    }
    if (state.kind === 'power') {
      const w = powerWatts(), ftp = Settings.get('ftp') || 250;
      const a = toM($('pw-from').value || 0), b = $('pw-to').value === '' ? L : Math.min(L, toM($('pw-to').value));
      let txt = Math.round(w) + ' W = ' + Math.round(100 * w / ftp) + '% of your ' + ftp + ' W FTP';
      if (L > 0 && b > a && state.times) {
        const dur = Cues.timeAt(state.track, state.times, b) - Cues.timeAt(state.track, state.times, a);
        txt += ' · ' + fmt(b - a) + ', about ' + Units.duration(dur) + ' at this pace';
      }
      $('pw-preview').textContent = txt;
    }
  }

  function cueRowClick(e) {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.closest('.cue-del')) {
      snapshot();
      state.route.cues = state.route.cues.filter(c => c.id !== id);
      changed();
      return;
    }
    if (e.target.closest('.cue-del-series')) {
      const c = state.route.cues.find(x => x.id === id);
      if (!c || !c.series) return;
      snapshot();
      const n = state.route.cues.filter(x => x.series === c.series).length;
      state.route.cues = state.route.cues.filter(x => x.series !== c.series);
      changed();
      say('cue-status', 'info', 'Removed the series of ' + n + '. Undo brings it back.');
      return;
    }
    if (e.target.closest('input')) return;
    state.hoverM = +tr.dataset.at;
    const p = RouteStore.positionAt(state.track, state.hoverM);
    if (p) map.setView(p.lat, p.lon, Math.max(map.view().z, 14));
    profile.setHover(state.hoverM);
  }

  function cueRowEdit(e) {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const c = state.route.cues.find(x => x.id === tr.dataset.id);
    if (!c) return;
    snapshot();
    if (e.target.classList.contains('cue-at')) {
      const m = toM(e.target.value);
      if (isFinite(m) && m >= 0) {
        const len = c.endM ? c.endM - c.atM : 0;
        c.atM = Math.min(m, state.track.length);
        if (len) c.endM = Math.min(state.track.length, c.atM + len);
        delete c.series;
      }
    } else if (e.target.classList.contains('cue-text')) {
      c.label = e.target.value.trim() || Cues.TYPES[c.type].name;
    }
    changed();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function exportCues() {
    const withTurns = $('export-turns').checked;
    return Cues.all(state.route, state.track, { turns: withTurns, slight: !!Settings.get('rlSlightTurns') });
  }

  function exportAs(kind) {
    const t = state.track;
    if (kind !== 'json' && (!t || t.n < 2)) { say('cue-status', 'warn', 'Nothing to export yet.'); return; }
    if (state.route.legs.some(l => l.kind === 'pending')) { say('cue-status', 'warn', 'Still routing — export again in a moment.'); return; }
    const base = (state.route.name || 'route').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'route';
    const cues = exportCues();
    let text, type, ext;
    if (kind === 'gpx') { text = Gpx.toGpx(state.route, t, cues, { units: units() }); type = 'application/gpx+xml'; ext = 'gpx'; }
    else if (kind === 'tcx') { text = Gpx.toTcx(state.route, t, cues, state.times, { units: units() }); type = 'application/vnd.garmin.tcx+xml'; ext = 'tcx'; }
    else if (kind === 'csv') { text = Gpx.toCsv(cues, t, state.times, units()); type = 'text/csv'; ext = 'csv'; }
    else { text = JSON.stringify(RouteStore.exportJson(state.route)); type = 'application/json'; ext = 'json'; }
    download(base + (kind === 'csv' ? '-cues' : '') + '.' + ext, text, type);
    state.lastExport = { kind, text };
    const lost = Cues.stranded(state.route, t);
    say('cue-status', lost.length ? 'warn' : 'ok', 'Exported ' + base + '.' + ext + ' with ' + cues.length + ' cue' + (cues.length === 1 ? '' : 's') + '.' +
      (lost.length ? ' ' + lost.length + ' cue' + (lost.length > 1 ? 's are' : ' is') + ' past the end of the route and left out.' : ''));
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    renderStats();
    renderCues();
    renderTools();
    previews();
    profile.draw(profileState());
    map.redraw();
  }

  function profileState() {
    return { track: state.track, cues: state.cues, times: state.times, units: units(), showTurns: !!Settings.get('rlShowTurns'), trails: state.trailRuns || [] };
  }

  function renderStats() {
    const t = state.track, r = state.route, U = units();
    if (document.activeElement !== $('route-name')) $('route-name').value = r.name || '';
    $('route-profile').value = Router.terrainKey(r.profile);
    $('terrain-hint').textContent = Router.terrain(r.profile).hint || '';
    if (!t || t.n < 2) { $('route-stats').innerHTML = '<p class="hint">Click the map to add a start point.</p>'; return; }
    const total = state.times[t.n - 1];
    const s = Settings.all();
    const stat = (v, unit, label, title) => '<div class="rstat"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="rstat-val">' + v + (unit ? '<span class="unit">' + unit + '</span>' : '') + '</div><div class="rstat-label">' + label + '</div></div>';
    const distV = fromM(t.length);
    const up = U === 'mi' ? Math.round(t.ascent * 3.28084) : Math.round(t.ascent);
    $('route-stats').innerHTML =
      stat(distV.toFixed(distV < 100 ? 1 : 0), Units.label(U), 'distance') +
      stat(t.hasEle ? up.toLocaleString() : '–', U === 'mi' ? 'ft' : 'm', 'climbing') +
      stat(Units.duration(total), '', 'at ' + s.rlRidePct + '% FTP') +
      stat(t.hasEle ? (t.maxGrade * 100).toFixed(0) : '–', '%', 'steepest 200 m', 'From satellite elevation data, smoothed. Switchbacks on a steep hillside can read steeper than they ride.') +
      surfaceBar(t.surface) + trailList();
    const b = $('trail-cues-btn');
    if (b) b.addEventListener('click', addTrailCues);
  }

  /** The rated trails on the route, in order, and a button to cue them. */
  function trailList() {
    const runs = state.trailRuns || [];
    if (!runs.length) return '';
    const hard = Trails.hardest(runs);
    const rows = runs.slice(0, 8).map(x =>
      '<div class="trail-row" data-at="' + x.fromM + '"><i class="tl-sw tl-' + x.r.key + '"></i>' +
      '<span class="trail-name">' + esc(x.way.n || 'Unnamed trail') + '</span>' +
      '<span class="trail-at">' + round1(fromM(x.fromM)).toFixed(1) + '–' + round1(fromM(x.toM)).toFixed(1) + '</span></div>').join('');
    return '<div class="route-trails">' +
      '<div class="trail-head"><span>Rated trails</span>' + (hard ? '<span>hardest: <i class="tl-sw tl-' + hard.key + '"></i>' + esc(hard.name) + '</span>' : '') + '</div>' +
      rows + (runs.length > 8 ? '<div class="hint">+ ' + (runs.length - 8) + ' more</div>' : '') +
      '<button class="btn btn-sm" id="trail-cues-btn" title="A cue where each rated trail starts, with its rating">Add trail cues</button></div>';
  }

  /** A note cue at the start of each rated trail: "BLK Wood Rat". Replaces earlier trail cues. */
  function addTrailCues() {
    const runs = state.trailRuns || [];
    if (!runs.length) return;
    snapshot();
    state.route.cues = state.route.cues.filter(c => c.type !== 'trail');
    for (const x of runs) {
      state.route.cues.push(Cues.make('trail', x.fromM, {
        label: x.r.rating.short + ' ' + (x.way.n || 'trail'),
        note: x.r.label + ' · ' + fmt(x.toM - x.fromM),
      }));
    }
    changed();
    say('cue-status', 'ok', runs.length + ' trail cue' + (runs.length > 1 ? 's' : '') + ' added, each with its rating.');
  }

  /** Paved / gravel / trail split from the router's way tags, and the hardest graded trail. */
  function surfaceBar(sf) {
    if (!sf) return '';
    const total = sf.paved + sf.gravel + sf.trail + sf.unknown;
    if (!(total > 0)) return '';
    const parts = [['paved', 'Paved', '#8b949e'], ['gravel', 'Gravel', '#c98500'], ['trail', 'Trail', '#199e70'], ['unknown', 'Unknown', '#30363d']]
      .filter(([k]) => sf[k] / total >= 0.005);
    return '<div class="surface">' +
      '<div class="surface-bar">' + parts.map(([k, , c]) => '<span style="width:' + (100 * sf[k] / total).toFixed(1) + '%;background:' + c + '"></span>').join('') + '</div>' +
      '<div class="surface-legend">' + parts.map(([k, name, c]) =>
        '<span><i style="background:' + c + '"></i>' + name + ' ' + Math.round(100 * sf[k] / total) + '%</span>').join('') +
      (sf.maxScale != null ? '<span title="Hardest OpenStreetMap mtb:scale grade on the route">hardest S' + esc(sf.maxScale) + '</span>' : '') +
      '</div></div>';
  }

  function renderTools() {
    const r = state.route, has = r.waypoints.length > 0;
    $('undo-btn').disabled = !state.undo.length;
    $('redo-btn').disabled = !state.redo.length;
    $('loop-btn').disabled = r.waypoints.length < 2;
    $('back-btn').disabled = r.waypoints.length < 2;
    $('reverse-btn').disabled = r.waypoints.length < 2;
    $('clear-btn').disabled = !has;
  }

  function renderCues() {
    const showTurns = !!Settings.get('rlShowTurns');
    const t = state.track, U = units();
    const rows = state.cues.filter(c => showTurns || !Cues.TYPES[c.type].turn);
    const custom = state.route.cues.length;
    const turns = state.cues.filter(c => Cues.TYPES[c.type].turn).length;
    $('cue-count').textContent = custom + ' cue' + (custom === 1 ? '' : 's') + (turns ? ' · ' + turns + ' turns' : '');
    const body = $('cue-rows');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="table-empty">' + (t && t.n > 1 ? 'No cues yet — add one above.' : 'No route yet') + '</td></tr>';
      return;
    }
    const stranded = Cues.stranded(state.route, t);
    body.innerHTML = rows.map(c => {
      const ty = Cues.TYPES[c.type];
      const eta = Units.duration(Cues.timeAt(t, state.times, c.atM));
      const editable = !c.auto;
      const at = round1(fromM(c.atM));
      return '<tr data-id="' + esc(c.id) + '" data-at="' + c.atM + '" class="' + (ty.turn ? 'cue-turn' : '') + '">' +
        '<td>' + (editable ? '<input type="number" class="cue-at" step="0.1" min="0" value="' + at + '">' : at.toFixed(1)) + '</td>' +
        '<td class="dim">' + eta + '</td>' +
        '<td class="cue-cell"><span class="cue-glyph" style="background:' + ty.color + '">' + esc(ty.glyph) + '</span>' +
          (editable ? '<input type="text" class="cue-text" value="' + esc(c.label) + '" maxlength="40">' : '<span>' + esc(c.label) + '</span>') +
          (c.note ? '<div class="cue-note">' + esc(c.note) + '</div>' : '') + '</td>' +
        '<td class="cue-actions">' + (editable
          ? (c.series ? '<button class="btn btn-sm cue-del-series" title="Remove the whole series">all</button>' : '') +
            '<button class="btn btn-sm cue-del" title="Remove this cue" aria-label="Remove">×</button>'
          : '') + '</td></tr>';
    }).join('') + (stranded.length
      ? '<tr><td colspan="4" class="hint">' + stranded.length + ' cue' + (stranded.length > 1 ? 's are' : ' is') + ' past the end of the route (' + fmt(t.length) + ') after an edit, and will not be exported.</td></tr>'
      : '');
  }

  function renderList() {
    const list = $('route-list');
    $('route-count').textContent = state.saved.length ? state.saved.length + ' saved' : '';
    if (!state.saved.length) { list.innerHTML = '<div class="list-empty">No saved routes yet</div>'; return; }
    list.innerHTML = state.saved.map(r => {
      let len = 0;
      try { len = RouteStore.build(r).length; } catch (_) {}
      const n = (r.cues || []).length;
      return '<div class="ride-item' + (r.id === state.route.id ? ' active' : '') + '" data-id="' + esc(r.id) + '">' +
        '<div class="ride-swatch"></div><div class="ride-body">' +
        '<div class="ride-name">' + esc(r.name) + '</div>' +
        '<div class="ride-meta">' + fmt(len) + ' · ' + n + ' cue' + (n === 1 ? '' : 's') + ' · ' + new Date(r.updated || Date.now()).toLocaleDateString() + '</div>' +
        '</div><button class="ride-del" title="Delete" aria-label="Delete route">×</button></div>';
    }).join('');
  }

  function say(id, kind, msg) {
    const el = $(id);
    if (!el) return;
    if (!msg) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="status status-' + (kind === 'loading' ? 'info status-loading' : kind || 'info') + '" style="margin-top:8px">' + esc(msg) + '</div>';
  }

  function flash(el) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 900);
  }

  function setBusy(on, msg) {
    busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
    const o = $('busy');
    o.hidden = busyDepth === 0;
    if (on && msg) $('busy-msg').textContent = msg;
  }

  // For the DOM test: read-only access to what the page is showing.
  window.RouteLabApp = { state, get map() { return map; }, rebuild, exportCues };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
