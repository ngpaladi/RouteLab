'use strict';

/**
 * Profile — the elevation chart under the map.
 *
 * Distance across, elevation up, the fill shaded by gradient. Target-power
 * blocks are bands behind it, cues are markers along the top, and the
 * pointer position is shared with the map both ways.
 *
 *   const p = Profile.create(canvas, { onHover(atM | null), onPick(atM) })
 *   p.draw({ track, cues, times, units }) · p.setHover(atM | null)
 */
const Profile = (() => {
  const PAD = { l: 44, r: 12, t: 22, b: 20 };

  // Gradient bands. Reserved status colours would read as warnings; these
  // are a plain light-to-dark ramp so steepness reads as depth.
  const RAMP = [
    [0.03, '#3d5a45'],
    [0.06, '#8a8a3a'],
    [0.09, '#b8782c'],
    [0.12, '#c4502f'],
    [Infinity, '#8f2c2c'],
  ];
  const DOWN = '#2f4a5e';

  function gradeColor(g) {
    if (g < -0.02) return DOWN;
    for (const [lim, c] of RAMP) if (g < lim) return c;
    return RAMP[RAMP.length - 1][1];
  }

  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    if (!(raw > 0) || !isFinite(raw)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
    return 10 * p;
  }

  function create(canvas, h = {}) {
    const ctx = canvas.getContext('2d');
    let state = null, hoverM = null, W = 0, H = 0;
    let geom = null;

    function size() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(s) {
      if (s) state = s;
      size();
      ctx.clearRect(0, 0, W, H);
      const st = state;
      if (!st || !st.track || st.track.n < 2 || !(st.track.length > 0)) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '12px -apple-system, sans-serif';
        ctx.fillText('Click the map to start a route — the elevation profile appears here.', PAD.l, H / 2);
        geom = null;
        return;
      }
      const t = st.track, U = st.units;
      const per = U === 'mi' ? Units.MI : 1000;
      const lo = t.hasEle ? t.minEle : 0, hi = t.hasEle ? t.maxEle : 1;
      const eSpan = Math.max(40, hi - lo);
      const e0 = lo - eSpan * 0.08, e1 = lo + eSpan * 1.12;
      const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
      const X = m => PAD.l + m / t.length * pw;
      const Y = e => PAD.t + ph - (e - e0) / (e1 - e0) * ph;
      geom = { X, pw, len: t.length };

      // Power bands.
      for (const c of st.cues || []) {
        if (c.type !== 'power' || c.isEnd) continue;
        const x0 = X(c.atM), x1 = X(c.endM || t.length);
        ctx.fillStyle = 'rgba(217, 89, 38, 0.13)';
        ctx.fillRect(x0, PAD.t, Math.max(1, x1 - x0), ph);
        ctx.fillStyle = '#d95926';
        ctx.font = '10px -apple-system, sans-serif';
        if (x1 - x0 > 34) ctx.fillText(c.watts + ' W', x0 + 3, PAD.t + ph - 4);
      }

      // Grid.
      ctx.strokeStyle = '#2c313a'; ctx.lineWidth = 1;
      ctx.fillStyle = '#8b949e'; ctx.font = '10px -apple-system, sans-serif';
      const eStep = niceStep(e1 - e0, 4);
      for (let e = Math.ceil(e0 / eStep) * eStep; e <= e1; e += eStep) {
        const y = Math.round(Y(e)) + 0.5;
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
        ctx.fillText(U === 'mi' ? Math.round(e * 3.28084) + ' ft' : Math.round(e) + ' m', 4, y + 3);
      }
      const dStep = niceStep(t.length / per, Math.max(3, Math.floor(pw / 80)));
      for (let k = 0; k * dStep * per <= t.length; k++) {
        const x = Math.round(X(k * dStep * per)) + 0.5;
        ctx.fillText((k * dStep).toFixed(dStep < 1 ? 1 : 0), x - 4, H - 5);
      }

      // Fill, one column per pixel, coloured by the grade across it.
      if (t.hasEle) {
        // Shaded in 4 px sections, each by its own grade (plus 50 m either
        // side): per-pixel shading flickers between bands every time the DEM
        // steps, which is noise, not road.
        const BW = 4;
        let col = null;
        for (let px = 0; px < pw; px++) {
          if (px % BW === 0) {
            const m0 = px / pw * t.length, m1 = Math.min(pw, px + BW) / pw * t.length;
            const a = RouteStore.positionAt(t, Math.max(0, m0 - 50)), b = RouteStore.positionAt(t, Math.min(t.length, m1 + 50));
            col = gradeColor((b.d - a.d) > 1 ? (b.ele - a.ele) / (b.d - a.d) : 0);
          }
          const p = RouteStore.positionAt(t, (px + 0.5) / pw * t.length);
          const y = Y(p.ele);
          ctx.fillStyle = col;
          ctx.fillRect(PAD.l + px, y, 1.2, PAD.t + ph - y);
        }
        ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        const step = Math.max(1, Math.floor(t.n / (pw * 2)));
        for (let i = 0; i < t.n; i += step) {
          const x = X(t.d[i]), y = Y(t.ele[i]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(X(t.length), Y(t.ele[t.n - 1]));
        ctx.stroke();
      } else {
        ctx.fillStyle = '#8b949e';
        ctx.fillText('No elevation for this route', PAD.l + 6, PAD.t + 12);
      }

      // Rated trails: a band along the bottom in the trail's colour.
      for (const x of st.trails || []) {
        const x0 = X(x.fromM), x1 = X(x.toM);
        ctx.fillStyle = x.r.rating.color;
        ctx.fillRect(x0, PAD.t + ph - 5, Math.max(2, x1 - x0), 5);
        // White and black signs vanish against the fill or the dark page without an edge.
        if (x.r.key === 'white' || x.r.key === 'black' || x.r.key === 'double') {
          ctx.strokeStyle = '#c9d1d9'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, PAD.t + ph - 5.5, Math.max(2, x1 - x0) - 1, 5);
        }
      }

      // Cue markers along the top.
      for (const c of st.cues || []) {
        const ty = Cues.TYPES[c.type];
        if (ty.turn && !st.showTurns) continue;
        const x = X(c.atM);
        ctx.strokeStyle = ty.color; ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(x + 0.5, PAD.t); ctx.lineTo(x + 0.5, PAD.t + ph); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = ty.color;
        ctx.beginPath(); ctx.arc(x, 10, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0d1117'; ctx.font = 'bold 9px -apple-system, sans-serif';
        ctx.fillText(ty.glyph, x - 3, 13);
      }

      // Hover readout.
      if (hoverM != null && hoverM >= 0 && hoverM <= t.length) {
        const p = RouteStore.positionAt(t, hoverM);
        const x = X(hoverM);
        ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, PAD.t); ctx.lineTo(x + 0.5, PAD.t + ph); ctx.stroke();
        const a = RouteStore.positionAt(t, Math.max(0, hoverM - 50)), b = RouteStore.positionAt(t, Math.min(t.length, hoverM + 50));
        const g = t.hasEle && b.d - a.d > 1 ? (b.ele - a.ele) / (b.d - a.d) : NaN;
        const eta = st.times ? Cues.timeAt(t, st.times, hoverM) : NaN;
        const on = (st.trails || []).find(x => hoverM >= x.fromM && hoverM <= x.toM);
        const txt = Units.dist(hoverM, U) + (t.hasEle ? ' · ' + Units.ele(p.ele, U) : '') +
          (isFinite(g) ? ' · ' + (g * 100).toFixed(1) + '%' : '') + (isFinite(eta) ? ' · ' + Units.duration(eta) : '') +
          (on ? ' · ' + (on.way.n || 'trail') + ' (' + on.r.rating.short + ')' : '');
        ctx.font = '11px -apple-system, sans-serif';
        const w = ctx.measureText(txt).width + 10;
        const bx = Math.min(W - PAD.r - w, Math.max(PAD.l, x + 6));
        ctx.fillStyle = 'rgba(13,17,23,0.85)';
        ctx.fillRect(bx, PAD.t + 2, w, 18);
        ctx.fillStyle = '#e6edf3';
        ctx.fillText(txt, bx + 5, PAD.t + 15);
      }
    }

    function atX(x) {
      if (!geom) return null;
      return Math.max(0, Math.min(geom.len, (x - PAD.l) / geom.pw * geom.len));
    }
    function evX(e) { return e.clientX - canvas.getBoundingClientRect().left; }

    canvas.addEventListener('pointermove', e => {
      const m = atX(evX(e));
      hoverM = m; draw();
      if (h.onHover) h.onHover(m);
    });
    canvas.addEventListener('pointerleave', () => { hoverM = null; draw(); if (h.onHover) h.onHover(null); });
    canvas.addEventListener('click', e => { const m = atX(evX(e)); if (m != null && h.onPick) h.onPick(m); });

    return {
      draw,
      setHover(m) { hoverM = m; draw(); },
      atX,
    };
  }

  return { create, gradeColor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Profile;
