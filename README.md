# RouteLab

Bike route planning in the browser. Click a route onto the map, choose how
rough you want it, from paved road through gravel to graded mountain-bike
trail, and add the cues you want on the day: eat every 20 km, drink, hold
260 W up the long climb. Then export a GPX or TCX your head unit will prompt
you from.

**[Open the tool →](https://www.noahpaladino.com/RouteLab/)**

No server, no account, no upload. Routes live in your browser's IndexedDB.

A sibling of [CritLab](https://github.com/ngpaladi/CritLab) and
[CrossLab](https://github.com/ngpaladi/CrossLab). The three share settings,
your FTP and weight, and the intervals.icu key.

## Features

- **Draw on the map**: click to add points; the route follows the road
  network between them. Drag a point to move it (only the two legs touching
  it are re-routed); drag the line to pull the route through somewhere new.
  Close the loop, make it an out-and-back, reverse it. Undo and redo cover
  everything.
- **Terrain and skill**: paved roads, quiet roads & bike paths, smooth
  gravel, rough gravel & dirt, and four mountain-bike levels, from beginner
  (S0–S1) to expert (S4) on OpenStreetMap's `mtb:scale`. Each level rides
  trails within its grade freely, pays a little at the top of it, and won't
  route on anything harder. Trails tagged for foot traffic only are avoided. The route
  shows its own split: % paved, gravel and trail, and the hardest graded
  trail on it.
- **Never a sidewalk**: every level bans sidewalks, footway crossings without bike
  access, and anything tagged `bicycle=no`, so a click beside a road attaches to
  the road. The gravel levels treat a main road with a bike lane like a quiet
  street, rather than zig-zagging round it.
- **Trail ratings on the map**: IMBA signs (white/green circle, blue square,
  black and double black diamond) from `mtb:scale:imba`, and the S-scale shown
  in the nearest sign's colour where that's all there is. Hover a trail for its
  name and grade; trails closed to bikes are dashed. The rated trails your route
  rides are listed with the hardest one, banded on the elevation profile, and can
  be added as cues ("BLK Wood Rat").
- **The cycle map** (CyclOSM) by default: bike lanes, surfaces and trails. Standard
  and topographic maps are in the layers menu, along with the trail overlay.
- **Cues**: one at a time (eat, drink, note, danger, summit, water stop), as a
  repeating series ("eat every 20 km from km 15"), or as a **power target**
  held from one distance to another, in watts or % of FTP. **On every climb**
  puts the target on every climb of 2 km or more at 3% or steeper. Place a cue
  by typing a distance, picking a spot on the map, or clicking the elevation
  profile. Drag a cue along the route to move it.
- **Turn cues** from the router: left, right, sharp, U-turns and roundabouts,
  with slight turns optional.
- **ETA on every cue** from a physics model rather than an average speed:
  your power (the target where there is one, a share of FTP elsewhere) against
  gravity, rolling resistance and drag on every stretch, using the mass and
  CdA CritLab uses.
- **Elevation profile** shaded by gradient, with power blocks and cues on it,
  hover-linked to the map.
- **Import** a `.gpx`, `.tcx` or `.fit` (its waypoints and course points become
  cues), or with intervals.icu connected, trace one of your past rides.
- **Export**:
  - **GPX**: the track plus a waypoint per cue, each placed exactly on a track point.
  - **TCX**: a Garmin course with CoursePoints, the reliable format for a Garmin.
  - **Cue sheet**: a CSV.
  - **JSON**: the whole route, to load back into RouteLab.

## Running locally

Requires Ruby and Bundler for the site, Node for the tests.

```bash
bundle install
bundle exec jekyll serve --livereload
# → http://localhost:4000/RouteLab/
```

## Tests

```bash
npm install        # jsdom, for the DOM test
npm test           # unit + DOM, no network

npm run test:unit  # track, cues, timing, climbs, GPX/TCX writers, MTB profiles
npm run test:dom   # builds the site, boots it in jsdom, draws and edits a route
```

`test/harness.js` runs on the sample route, a real 69 km BRouter result. It
checks:

- the router's turn hints point where the road actually turns;
- every exported cue lands exactly on a track point;
- GPX and TCX read back with every point and cue;
- TCX course-point names fit Garmin's 10 characters, in schema order.

`test/dom.js` runs against a fake network that routes a dog-leg between any
two points. It clicks, drags, undoes, changes terrain, adds every kind of cue,
exports, and imports the export again.

## Architecture

Jekyll static site on GitHub Pages. No build step beyond Jekyll, no framework,
no bundler, no runtime dependencies.

```
assets/js/
  Intervals.js   — intervals.icu v1 client (shared with CritLab and CrossLab)
  Fit.js         — FIT binary decoder (shared), for importing rides
  RouteStore.js  — shared Settings, Geo helpers, the route model, IndexedDB
  Router.js      — BRouter legs, terrain levels, MTB profile upload, surfaces, elevation, search
  Cues.js        — turn cues, series, power targets, climbs, the timing model
  Gpx.js         — GPX/TCX import, GPX/TCX/CSV export, Units
  TileMap.js     — canvas slippy map: tiles (faded in), pan, zoom, pinch, scale bar, overlay hook
  Trails.js      — IMBA / S-scale trail ratings from Overpass: tiles, cache, backoff, route matching
  Profile.js     — the elevation profile
  Tour.js        — welcome dialog and walkthrough (shared, byte-identical)
  app.js         — UI state, editing, undo, rendering
assets/data/
  sample-route.json — the sample loop (and test fixture)
  fastbike.brf, trekking.brf, gravel.brf, mtb.brf
                    — BRouter's stock profiles, the templates every terrain level is built from (MIT, BRouter contributors)
```

### The route model

A route is waypoints plus one **leg** between each consecutive pair. A leg
holds its own geometry (`[lat, lon, ele]` rows), the router's turn hints and
a surface summary. Legs are replaced, never edited, so undo snapshots share
them by reference. `RouteStore.build` flattens the legs into one track with
cumulative distance and smoothed elevation.

**Custom cues are anchored by distance** from the start (`atM`), because "eat
every 20 km" is about distance. **Turn cues are derived** from the legs on
every build, so they follow the road.

### Terrain

Every level routes with its own copy of a stock BRouter profile, rewritten in
`Router.profileText` and uploaded once per session to
`brouter.de/brouter/profile` (and again if the server has dropped it):

- **all levels**: a rule at the end of the way context makes sidewalks,
  footway crossings without bike access and `bicycle=no` ways impassable;
- **gravel**: main roads with a bike lane lose their base surcharge, the 1.8×
  "no speed limit tagged" penalty and the cost of joining one;
- **MTB**: the `mtb:scale` pricing rewritten per level, a `sac_scale` penalty,
  foot-only ways forbidden, roughness weighted down as skill goes up.

If an upload is refused, that leg uses the stock profile and the app says so.

### Trail ratings

BRouter's lookup table has no `mtb:scale:imba`, so IMBA grades can't steer the
router; they come from Overpass instead, per z11 tile (~15 km), one request at
a time, visible area first, cached in localStorage for 30 days. The public
Overpass servers are often at capacity; failed areas are retried with
exponential backoff and the legend says so. A route "rides" a trail where its
points are within 12 m of it and running the same way within 35°.

## Storage, shared with CritLab and CrossLab

| key | where | what | shared |
|---|---|---|---|
| `cl-settings` | localStorage | preferences; `ftp`, `mass`, `cda`, `crr` are shared, `rl*` keys are RouteLab's | yes |
| `cl-icu-key` | local/sessionStorage | the intervals.icu key, in its own slot | yes |
| `rl-view`, `rl-current` | localStorage | map position and open route | no |
| `rl-trails-*` | localStorage | cached trail ratings, 30 days | no |
| `routelab` / `routes` | IndexedDB | saved routes with their cues | no — own database |

RouteLab's reset clears only `rl*` keys.

## Privacy

Static page. Map tiles come from the OpenStreetMap community tile servers.
Each leg's two endpoints go to brouter.de. Overpass sees the areas you look at
with the trail overlay on, and the area around your route. Open-Meteo is asked for elevation
only for straight-line legs and imports without any. Nominatim sees what you
search for. The intervals.icu key goes only to intervals.icu.

## License

MIT. `assets/data/mtb.brf` is from [BRouter](https://github.com/abrensch/brouter) (MIT).
