'use strict';

/**
 * Gpx — reading tracks in, writing courses with cues out.
 *
 * Export writes GPX 1.1 (a track plus one <wpt> per cue) and TCX (a Course
 * with CoursePoints). Two details matter to head units:
 *
 *   · Every cue sits exactly on a track point. A waypoint that is merely near
 *     the line can be dropped, or given distance 0 so it fires at the start.
 *     The cue's position is interpolated along the track and that point is
 *     inserted into the track itself (or the cue snaps to an existing point
 *     less than a metre away).
 *   · Names are short. TCX's CoursePointName_t is 1–10 characters, and Garmin
 *     shows about that much of a GPX name. The full text goes in cmt/desc
 *     and Notes.
 *
 * GPX waypoints are not part of any standard for course points; Garmin
 * Connect and Wahoo make cues of them with varying success. TCX
 * CoursePoints are Garmin's own format, so that export is the reliable one
 * for a Garmin.
 *
 * Parsing is by regular expression rather than DOMParser so the same code
 * runs in the node test harness. GPX and TCX are regular enough for it.
 */
const Gpx = (() => {

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }
  function unesc(s) {
    return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
  }
  function tag(body, name) {
    const m = new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?' + name + '>', 'i').exec(body);
    return m ? unesc(m[1]) : '';
  }
  function attr(head, name) {
    const m = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(head);
    return m ? m[1] : null;
  }

  // ── Import ────────────────────────────────────────────────────────────────

  /** GPX or TCX text → { name, rows: [[lat, lon, ele]], marks: [{lat, lon, name, type, desc}] }. */
  function parse(text) {
    if (/<TrainingCenterDatabase/i.test(text)) return parseTcx(text);
    const rows = [];
    const marks = [];
    // Tracks first; a file with only a route (<rtept>) is accepted too.
    const pt = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
    let m, kind = null;
    while ((m = pt.exec(text))) {
      if (kind && m[1].toLowerCase() !== kind) continue;
      kind = kind || m[1].toLowerCase();
      const lat = parseFloat(attr(m[2], 'lat')), lon = parseFloat(attr(m[2], 'lon'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const e = parseFloat(tag(m[3] || '', 'ele'));
      rows.push([lat, lon, isFinite(e) ? e : null]);
    }
    const wp = /<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/gi;
    while ((m = wp.exec(text))) {
      const lat = parseFloat(attr(m[1], 'lat')), lon = parseFloat(attr(m[1], 'lon'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const b = m[2] || '';
      marks.push({ lat, lon, name: tag(b, 'name'), type: tag(b, 'type') || tag(b, 'sym'), desc: tag(b, 'desc') || tag(b, 'cmt') });
    }
    const meta = /<metadata\b[\s\S]*?<\/metadata>/i.exec(text);
    const trk = /<trk\b[\s\S]*?<\/trk>/i.exec(text);
    const name = (trk && tag(trk[0].replace(/<trkseg[\s\S]*$/i, ''), 'name')) || (meta && tag(meta[0], 'name')) || '';
    return { name, rows, marks };
  }

  function parseTcx(text) {
    const rows = [], marks = [];
    const tp = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/gi;
    let m;
    while ((m = tp.exec(text))) {
      const lat = parseFloat(tag(m[1], 'LatitudeDegrees')), lon = parseFloat(tag(m[1], 'LongitudeDegrees'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const e = parseFloat(tag(m[1], 'AltitudeMeters'));
      rows.push([lat, lon, isFinite(e) ? e : null]);
    }
    const cp = /<CoursePoint\b[^>]*>([\s\S]*?)<\/CoursePoint>/gi;
    while ((m = cp.exec(text))) {
      const lat = parseFloat(tag(m[1], 'LatitudeDegrees')), lon = parseFloat(tag(m[1], 'LongitudeDegrees'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      marks.push({ lat, lon, name: tag(m[1], 'Name'), type: tag(m[1], 'PointType'), desc: tag(m[1], 'Notes') });
    }
    const course = /<(Course|Activity)\b[\s\S]*?<Name>([\s\S]*?)<\/Name>/i.exec(text);
    return { name: course ? unesc(course[2]) : '', rows, marks };
  }

  /** Guess our cue type from whatever another tool called it. */
  function cueType(mark) {
    const s = (mark.type + ' ' + mark.name).toLowerCase();
    if (/food|eat|snack|gel|feed|restaurant|cafe|café/.test(s)) return 'eat';
    if (/water|drink|bottle|fountain/.test(s)) return 'drink';
    if (/summit|peak|top|kom|qom|\bcat\b|category/.test(s)) return 'summit';
    if (/danger|caution|hazard|warning/.test(s)) return 'danger';
    if (/\bleft\b/.test(s)) return 'left';
    if (/\bright\b/.test(s)) return 'right';
    if (/straight/.test(s)) return 'straight';
    if (/\d+\s*w\b|watts|power/.test(s)) return 'note';
    return 'note';
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * The track with a point inserted at every cue.
   * Returns { pts: [{lat, lon, ele, d, t}], at: Map(cue.id → index into pts) }.
   */
  function withCuePoints(track, cues, times) {
    const pts = [];
    for (let i = 0; i < track.n; i++) {
      pts.push({ lat: track.lat[i], lon: track.lon[i], ele: track.hasEle ? track.ele[i] : null, d: track.d[i], t: times ? times[i] : null, src: i });
    }
    // Insert from the far end backwards so earlier indices stay valid while we work.
    const placed = cues.map(c => ({ c, p: RouteStore.positionAt(track, c.atM) })).filter(x => x.p);
    placed.sort((a, b) => b.c.atM - a.c.atM);
    const inserted = [];
    for (const { c, p } of placed) {
      const i = p.i, j = Math.min(i + 1, track.n - 1);
      let k;
      if (Math.abs(track.d[i] - p.d) < 1) k = i;
      else if (Math.abs(track.d[j] - p.d) < 1) k = j;
      if (k != null) { inserted.push({ id: c.id, src: k, extra: 0 }); continue; }
      const t = times ? times[i] + (times[j] - times[i]) * p.f : null;
      const pt = { lat: p.lat, lon: p.lon, ele: track.hasEle ? p.ele : null, d: p.d, t, src: i, cue: c.id };
      // Several cues between the same two track points go in distance order.
      let at = i + 1;
      while (at < pts.length && pts[at].src === i && pts[at].d <= p.d) at++;
      pts.splice(at, 0, pt);
    }
    const at = new Map();
    for (let k = 0; k < pts.length; k++) if (pts[k].cue) at.set(pts[k].cue, k);
    for (const x of inserted) {
      // Snapped cues: the first point carrying that original track index.
      let k = x.src;
      while (k < pts.length && !(pts[k].src === x.src && !pts[k].cue)) k++;
      at.set(x.id, k);
    }
    return { pts, at };
  }

  function f6(x) { return (Math.round(x * 1e7) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, ''); }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }

  function describe(c, units) {
    const parts = [];
    if (c.label && c.label !== Cues.shortName(c)) parts.push(c.label);
    if (c.note) parts.push(c.note);
    parts.push('at ' + Units.dist(c.atM, units));
    return parts.join(' · ');
  }

  /** GPX 1.1: <wpt> cues first (the schema puts them before <trk>), then the track. */
  function toGpx(route, track, cues, { units = 'km' } = {}) {
    const { pts, at } = withCuePoints(track, cues);
    const L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<gpx version="1.1" creator="RouteLab" xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">');
    L.push('  <metadata><name>' + esc(route.name) + '</name><time>' + new Date().toISOString() + '</time></metadata>');
    for (const c of cues) {
      const k = at.get(c.id);
      if (k == null) continue;
      const p = pts[k];
      const type = Cues.TYPES[c.type].tcx;
      L.push('  <wpt lat="' + f6(p.lat) + '" lon="' + f6(p.lon) + '">' +
        (p.ele != null ? '<ele>' + f1(p.ele) + '</ele>' : '') +
        '<name>' + esc(Cues.shortName(c)) + '</name>' +
        '<cmt>' + esc(c.label || '') + '</cmt>' +
        '<desc>' + esc(describe(c, units)) + '</desc>' +
        '<sym>' + esc(type) + '</sym><type>' + esc(type) + '</type></wpt>');
    }
    L.push('  <trk><name>' + esc(route.name) + '</name><type>cycling</type><trkseg>');
    for (const p of pts) {
      L.push('    <trkpt lat="' + f6(p.lat) + '" lon="' + f6(p.lon) + '">' + (p.ele != null ? '<ele>' + f1(p.ele) + '</ele>' : '') + '</trkpt>');
    }
    L.push('  </trkseg></trk>');
    L.push('</gpx>');
    return L.join('\n') + '\n';
  }

  /** TCX Course with CoursePoints. Times come from the power-based estimate. */
  function toTcx(route, track, cues, times, { units = 'km', start = Date.UTC(2000, 0, 1, 8) } = {}) {
    const { pts, at } = withCuePoints(track, cues, times);
    const iso = s => new Date(start + Math.round(s * 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const pos = p => '<Position><LatitudeDegrees>' + f6(p.lat) + '</LatitudeDegrees><LongitudeDegrees>' + f6(p.lon) + '</LongitudeDegrees></Position>';
    const first = pts[0], last = pts[pts.length - 1];
    const L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">');
    L.push('  <Courses><Course>');
    L.push('    <Name>' + esc(String(route.name || 'Route').slice(0, 15)) + '</Name>');
    L.push('    <Lap><TotalTimeSeconds>' + f1(last.t || 0) + '</TotalTimeSeconds><DistanceMeters>' + f1(track.length) + '</DistanceMeters>' +
      '<BeginPosition><LatitudeDegrees>' + f6(first.lat) + '</LatitudeDegrees><LongitudeDegrees>' + f6(first.lon) + '</LongitudeDegrees></BeginPosition>' +
      '<EndPosition><LatitudeDegrees>' + f6(last.lat) + '</LatitudeDegrees><LongitudeDegrees>' + f6(last.lon) + '</LongitudeDegrees></EndPosition>' +
      '<Intensity>Active</Intensity></Lap>');
    L.push('    <Track>');
    for (const p of pts) {
      L.push('      <Trackpoint><Time>' + iso(p.t || 0) + '</Time>' + pos(p) +
        (p.ele != null ? '<AltitudeMeters>' + f1(p.ele) + '</AltitudeMeters>' : '') +
        '<DistanceMeters>' + f1(p.d) + '</DistanceMeters></Trackpoint>');
    }
    L.push('    </Track>');
    for (const c of cues) {
      const k = at.get(c.id);
      if (k == null) continue;
      const p = pts[k];
      L.push('    <CoursePoint><Name>' + esc(Cues.shortName(c)) + '</Name><Time>' + iso(p.t || 0) + '</Time>' + pos(p) +
        (p.ele != null ? '<AltitudeMeters>' + f1(p.ele) + '</AltitudeMeters>' : '') +
        '<PointType>' + Cues.TYPES[c.type].tcx + '</PointType>' +
        '<Notes>' + esc(describe(c, units)) + '</Notes></CoursePoint>');
    }
    L.push('  </Course></Courses>');
    L.push('</TrainingCenterDatabase>');
    return L.join('\n') + '\n';
  }

  /** A cue sheet as CSV, for printing or a top-tube sticker. */
  function toCsv(cues, track, times, units) {
    const L = ['distance,eta,type,cue,note'];
    for (const c of cues) {
      const cell = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
      L.push([Units.distNum(c.atM, units).toFixed(2), Units.duration(Cues.timeAt(track, times, c.atM)),
        Cues.TYPES[c.type].name, cell(c.label), cell(c.note || '')].join(','));
    }
    return L.join('\n') + '\n';
  }

  return { parse, cueType, withCuePoints, toGpx, toTcx, toCsv, esc };
})();

/**
 * Units — km or miles, everywhere a distance is shown or typed.
 */
const Units = (() => {
  const MI = 1609.344;
  function per(units) { return units === 'mi' ? MI : 1000; }
  function distNum(m, units) { return m / per(units); }
  function dist(m, units, dp) {
    const v = distNum(m, units);
    return v.toFixed(dp != null ? dp : v < 10 ? 2 : 1) + ' ' + (units === 'mi' ? 'mi' : 'km');
  }
  function toM(v, units) { return v * per(units); }
  function label(units) { return units === 'mi' ? 'mi' : 'km'; }
  function ele(m, units) { return units === 'mi' ? Math.round(m * 3.28084) + ' ft' : Math.round(m) + ' m'; }
  function duration(s) {
    if (!isFinite(s)) return '–';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m === 60 ? (h + 1) + ':00' : h + ':' + String(m).padStart(2, '0');
  }
  return { dist, distNum, toM, label, ele, duration, MI };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Gpx, Units };
