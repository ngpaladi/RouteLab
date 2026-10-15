'use strict';

/**
 * TileMap — a small slippy map on a canvas: raster tiles, pan, zoom, pinch,
 * and an overlay hook the app draws the route into.
 *
 * CritLab and CrossLab draw their basemaps from Overpass vector data, which
 * is fine for one race course and hopeless for planning across a county, so
 * this one uses ordinary raster tiles. No library: it is Web Mercator, a tile
 * cache and pointer events, and it keeps the "no runtime dependencies" rule.
 *
 * Tiles are drawn, never read back, so cross-origin tiles taint nothing that
 * matters. While a tile loads, its parent (up to three levels up) stands in.
 *
 *   const m = TileMap.create(el, { onDraw(ctx, map), onClick(e), hitTest(x, y),
 *                                  onDragStart(hit, e), onDrag(hit, e), onDragEnd(hit, e),
 *                                  onHover(e), onView(view) })
 *   m.setView(lat, lon, z) · m.fitBounds(s, w, n, e) · m.project(lat, lon) → {x, y}
 *   m.unproject(x, y) → {lat, lon} · m.redraw() · m.setLayer(key)
 */
const TileMap = (() => {
  const T = 256;

  const LAYERS = {
    osm: {
      name: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19,
      attr: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
    cyclosm: {
      name: 'CyclOSM (bike lanes, surfaces)',
      url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', sub: 'abc', max: 20,
      attr: '<a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
    topo: {
      name: 'OpenTopoMap (contours)',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub: 'abc', max: 17,
      attr: '© <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA) · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  };

  const MIN_Z = 2, MAX_Z = 19;

  // ── Web Mercator, in pixels at zoom z ─────────────────────────────────────
  function toWorld(lat, lon, z) {
    const s = T * Math.pow(2, z);
    const la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
    return { x: (lon + 180) / 360 * s, y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * s };
  }
  function fromWorld(x, y, z) {
    const s = T * Math.pow(2, z);
    const lon = x / s * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / s;
    return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon };
  }

  function create(el, h = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'tilemap-canvas';
    el.appendChild(canvas);
    const attr = document.createElement('div');
    attr.className = 'tilemap-attr';
    el.appendChild(attr);
    const ctx = canvas.getContext('2d');

    let lat = 39, lon = -98, z = 4;
    let layer = LAYERS.osm;
    let W = 0, H = 0, dpr = 1;
    const tiles = new Map();
    let pending = false;

    function size() {
      const r = el.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    }

    function project(la, lo) {
      const c = toWorld(lat, lon, z), p = toWorld(la, lo, z);
      return { x: W / 2 + (p.x - c.x), y: H / 2 + (p.y - c.y) };
    }
    function unproject(x, y) {
      const c = toWorld(lat, lon, z);
      return fromWorld(c.x + x - W / 2, c.y + y - H / 2, z);
    }

    function tileUrl(tz, tx, ty) {
      const s = layer.sub ? layer.sub[(tx + ty) % layer.sub.length] : '';
      return layer.url.replace('{s}', s).replace('{z}', tz).replace('{x}', tx).replace('{y}', ty);
    }

    function tile(tz, tx, ty, load) {
      const key = layer.url + '|' + tz + '/' + tx + '/' + ty;
      let t = tiles.get(key);
      if (!t && load) {
        t = { img: new Image(), ok: false };
        t.img.onload = () => { t.ok = true; redraw(); };
        t.img.onerror = () => { t.failed = true; };
        t.img.src = tileUrl(tz, tx, ty);
        tiles.set(key, t);
        if (tiles.size > 600) tiles.delete(tiles.keys().next().value);
      }
      return t;
    }

    function draw() {
      pending = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#e8e4dc';
      ctx.fillRect(0, 0, W, H);
      const tz = Math.max(0, Math.min(layer.max, Math.round(z)));
      const k = Math.pow(2, z - tz), size = T * k;
      const c = toWorld(lat, lon, tz);
      const x0 = c.x * k - W / 2, y0 = c.y * k - H / 2;
      const n = Math.pow(2, tz);
      const ix0 = Math.floor(x0 / size), iy0 = Math.floor(y0 / size);
      const ix1 = Math.floor((x0 + W) / size), iy1 = Math.floor((y0 + H) / size);
      for (let iy = iy0; iy <= iy1; iy++) {
        if (iy < 0 || iy >= n) continue;
        for (let ix = ix0; ix <= ix1; ix++) {
          const tx = ((ix % n) + n) % n;
          const sx = ix * size - x0, sy = iy * size - y0;
          const t = tile(tz, tx, iy, true);
          if (t && t.ok) { ctx.drawImage(t.img, sx, sy, size + 0.5, size + 0.5); continue; }
          // Parent stand-in while this one loads.
          for (let up = 1; up <= 3 && tz - up >= 0; up++) {
            const f = 1 << up;
            const p = tile(tz - up, tx >> up, iy >> up, false);
            if (p && p.ok) {
              const sub = T / f;
              ctx.drawImage(p.img, (tx % f) * sub, (iy % f) * sub, sub, sub, sx, sy, size + 0.5, size + 0.5);
              break;
            }
          }
        }
      }
      if (h.onDraw) h.onDraw(ctx, api);
    }

    function redraw() {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || (f => setTimeout(f, 16)))(draw);
    }

    function changed() { redraw(); if (h.onView) h.onView({ lat, lon, z }); }

    function setView(la, lo, zz) {
      lat = la; lon = lo; if (zz != null) z = Math.max(MIN_Z, Math.min(MAX_Z, zz));
      changed();
    }

    /** Zoom by dz keeping the point under (x, y) where it is. */
    function zoomAt(dz, x, y) {
      const before = unproject(x, y);
      z = Math.max(MIN_Z, Math.min(MAX_Z, z + dz));
      const c = toWorld(lat, lon, z), p = toWorld(before.lat, before.lon, z);
      const nc = fromWorld(c.x + (p.x - c.x) - (x - W / 2), c.y + (p.y - c.y) - (y - H / 2), z);
      lat = nc.lat; lon = nc.lon;
      changed();
    }

    function fitBounds(s, w, n, e, pad = 40) {
      if (!(n >= s) || !(e >= w)) return;
      let zz = MAX_Z;
      for (; zz > MIN_Z; zz -= 0.25) {
        const a = toWorld(n, w, zz), b = toWorld(s, e, zz);
        if (b.x - a.x <= W - 2 * pad && b.y - a.y <= H - 2 * pad) break;
      }
      const a = toWorld(n, w, zz), b = toWorld(s, e, zz);
      const c = fromWorld((a.x + b.x) / 2, (a.y + b.y) / 2, zz);
      setView(c.lat, c.lon, Math.min(zz, 17));
    }

    function setLayer(key) {
      layer = LAYERS[key] || LAYERS.osm;
      attr.innerHTML = layer.attr;
      redraw();
    }

    // ── Input ──────────────────────────────────────────────────────────────
    const pointers = new Map();
    let gesture = null;   // { kind: 'pan'|'item'|'pinch', ... }

    function local(e) {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const ll = unproject(x, y);
      return { x, y, lat: ll.lat, lon: ll.lon, shift: !!e.shiftKey, alt: !!e.altKey, button: e.button || 0 };
    }

    canvas.addEventListener('pointerdown', e => {
      if (e.button && e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), z0: z, moved: true };
        return;
      }
      const hit = h.hitTest ? h.hitTest(p.x, p.y) : null;
      gesture = { kind: hit ? 'item' : 'pan', hit, start: p, last: p, moved: false, started: false };
    });

    canvas.addEventListener('pointermove', e => {
      const p = local(e);
      if (!gesture) { if (h.onHover) h.onHover(p); return; }
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (gesture.kind === 'pinch') {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const target = gesture.z0 + Math.log2(d / gesture.dist);
        zoomAt(target - z, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (!gesture.moved && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) < 4) return;
      gesture.moved = true;
      if (gesture.kind === 'pan') {
        const c = toWorld(lat, lon, z);
        const nc = fromWorld(c.x - (p.x - gesture.last.x), c.y - (p.y - gesture.last.y), z);
        lat = nc.lat; lon = nc.lon;
        changed();
      } else {
        if (!gesture.started) { gesture.started = true; if (h.onDragStart) h.onDragStart(gesture.hit, gesture.start); }
        if (h.onDrag) h.onDrag(gesture.hit, p);
      }
      gesture.last = p;
    });

    function end(e) {
      pointers.delete(e.pointerId);
      if (!gesture) return;
      const g = gesture;
      if (g.kind === 'pinch') { if (!pointers.size) gesture = null; return; }
      gesture = null;
      const p = local(e);
      if (!g.moved) { if (h.onClick) h.onClick({ ...p, hit: g.hit }); }
      else if (g.kind === 'item' && g.started && h.onDragEnd) h.onDragEnd(g.hit, p);
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); gesture = null; });
    canvas.addEventListener('pointerleave', () => { if (!gesture && h.onHover) h.onHover(null); });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const p = local(e);
      const dz = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025);
      zoomAt(Math.max(-1, Math.min(1, dz)), p.x, p.y);
    }, { passive: false });

    canvas.addEventListener('contextmenu', e => {
      const p = local(e);
      const hit = h.hitTest ? h.hitTest(p.x, p.y) : null;
      if (h.onContext && h.onContext({ ...p, hit }) !== false) e.preventDefault();
    });

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { size(); redraw(); }).observe(el);
    else window.addEventListener('resize', () => { size(); redraw(); });

    size();
    setLayer('osm');

    const api = {
      canvas, project, unproject, setView, zoomAt, fitBounds, setLayer, redraw,
      resize() { size(); redraw(); },
      zoomBy(dz) { zoomAt(dz, W / 2, H / 2); },
      view: () => ({ lat, lon, z }),
      get width() { return W; }, get height() { return H; },
    };
    return api;
  }

  return { create, LAYERS, toWorld, fromWorld };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TileMap;
