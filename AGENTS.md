# Agent guide — Strata

## Invariants

These rules are non-negotiable. Regressions are guarded by unit tests and Playwright e2e.

### Every feature or fix adds a changelog entry

Any PR that adds a feature or fixes something a person would notice adds **one entry at the top** of `CHANGELOG` in `src/ui/changelogEntries.ts` (Help › Changelog in the app). Newest first; dates are the day it ships (`YYYY-MM-DD`).

- `title` and `body`: plain words about what it does for the person, not how it was built. `where`: the path in words ("3D view › Rake", "Parameters › Steel base › Fixing holes"), shown when the control isn't on screen.
- `target` is what **Show me** opens and lights up: `tab`, `ui` (store state to set), `param` (a parameter row; its panel opens), `group` (a parameter panel), and `path`: names opened in order, the last one lit. Names are `data-hl` (or existing `data-testid`) values, never CSS paths, so panels can move. Put `data-hl="your-name"` on the new control (and on whatever must be clicked to reach it: menus take `hl`, Inspector sections take `hl`).
- When you move or rename a control, keep its `data-hl`. `test/changelog.test.ts` fails when a target names a `data-hl`/`data-testid`, param, group or tab that no longer exists; `e2e/changelog.spec.ts` checks that Show me lights the right control.
- Internal-only work (tests, CI, refactors nobody sees) needs no entry.

### Nested sheet holes travel with their parent

Round holes (`CIRCLE` in cut DXF) are detected on the part in local coordinates, then transformed with that part’s nest placement. A CIRCLE must lie inside **exactly one** part outline and must not overlap another part. Irregular cut-outs stay LWPOLYLINE. Enforced by `test/sheet-dxf-cut.test.ts`.

### Thin necks honour min-feature and Small fragments mode

Material narrower than **Min feature** is repaired on the plate outline: **merge** / **auto** widen the neck, **drop** opens (splits or removes) it, **keep** leaves it (warnings remain). User `minFeature` / `minFragment` values are never overwritten. Enforced by `repairThinNecks`, `test/fragments.test.ts`, and Neasden ×11/×21 fit-check tests.

### Kerf-narrow gaps and unsupported overhangs are cleaned, then export refuses errors

Gaps narrower than **Kerf** cannot be cut. **merge** / **auto** close them (weld), **drop** widens the void to ≥ kerf + margin, **keep** leaves the error. Unsupported flat-stack pieces (no glue on the layer below) are merged into a touching sibling, dropped, or in **drop** mode trimmed to the supported area. User `kerf` / `minFeature` / `minFragment` are never overwritten.

Fabrication export (ZIP, build pack, plate/sheet DXFs, CLI) **refuses** while any fit-check error remains (`FitCheckExportError`). Enforced by `repairKerfGaps`, `repairOverhangs`, `assertExportable`, `test/fragments.test.ts`, and Neasden ×11/×21 tests.

### Fabrication build pack contains every plate

The fabrication build pack must contain **every plate** in the model (`sliced.plates`), including empty or zero-area layers. Zip `plates/*.dxf` count, `manifest.json` `plateCount`, the HTML cover legend (`data-plate-count`), and the Every plate gallery (`data-plate-key` per plate) must equal `sliced.plates.length`. Cuttable plates also have laser part DXFs. Filename sanitisation must not overwrite another plate. Enforced by `buildPackIntegrity` and `test/build-pack-integrity.test.ts`. On mismatch the UI shows an error and the CLI exits with code 1.

### Map faces use real elevation, not the image pipeline

Map terrain on a face is **metric elevation in metres × vertical exaggeration**, converted to millimetres at the map’s plan scale (`masterWidthMm / mapWidthM`) and applied **directly as plate-top heights**.

It must **bypass** every photo/image step:

- p2/p98 (or any percentile) normalisation of the elevation grid
- image-as-height mix with strata (`imgMix`)
- contrast, blur / smooth, invert-as-filter
- depth-from-photo flatten, curve, and perspective spacing
- background-to-plate flat (`depthFlat` / `flatLevelMode`) — image faces only
- impression “flat level” (`topFloor: flat`) and strata-flow (`edgeFlow`)
- the image height-range cap (`imgRange`)
- water flatten when water mode is **raw** (only `flat`, or `bathy` fallback, may flatten water)

`mapGridToDepth` stores true min/max elevation. `buildMapHeightField` samples those metres (windowed only by user near/far) and sets plate heights. Auto exaggeration may still use a robust (p98−p2) estimate to pick the **factor**; plate maths use **true** `(max − min)` metres (`mapOrtho.reliefM`). The Map tab live line and the 3D caption **share the built geometry** (`formatLiveMapReadout` contains `formatMapHeightCaption`): flat stack is **n × thickness**, and when the height field is taller than that the caption adds **capped at N layers** (same test as the slicer warning). Exaggeration still changes how many layers each area gets; do **not** auto-raise `plateCount` / thickness. Upright map faces are **terrain lo–hi mm** from cut-outline vertices (`plateOutlineYRangeMm`). Do not show a plan-scale millimetre figure from another preset’s master width (Stamped 520 mm vs Vermilion 800 mm), and do not use flat-outline Y (plan footprint) as plate height. A map top face does not keep the default insert (Vermilion fin).

The Map tab hillshade can look correct while 3D plates stay a ~32 mm band at `stackHeight` ± `erosionAmp` (live Neasden: 232–264 mm). That means the pipeline still used `buildHeightField` and never called `buildMapHeightField`.

Map world frame is **right-handed ENU**: **+X south** (S-01 / Front at −X = north), **+Y up**, **+Z west** (east = −Z). 3D Top with north up has **east on the right**. 3D Front (from the north looking south) and each plate DXF viewed face-on from the north have **east on the left** — the same view of the real landscape. OSM engrave uses that plate +x (art west → part maxX). Do not roll the camera to fake east–west; `sampleMapHeightGrid` shares this mapping and is not independent truth. Enforced by `test/map-orient.test.ts` (NE-corner ENU + Top projection + engrave vs profile).

Only **flat stacks** snap terrain to the layer budget (Jenks/quantile/equal breaks). Upright stacks keep continuous heights unless the map's **Terraced layers** option (`MapSpec.terraced`) is on. `mapBuildKey` includes the plate stack (`mapStackFromProject`: plate count, thickness, base length/width, kerf, slicing), so changing any of them rebuilds terrain.

Map plate tops are cut as smooth curves: `mapOutline` (slicer.ts) samples every **Map profile step** (`curveStep`, 0.4 mm), smooths with a Gaussian of **Map curve smoothing** (`curveSmooth`, 0.75 mm) and simplifies at **Map curve tolerance** (`curveTolerance`, 0.01 mm) so `fitArcs` writes most of it as arcs. Height lookups are bicubic (`cubicAt`/`gridSampleBicubic` in mapGrid.ts, clamped to the nearest cells so summits and lakes never overshoot). The grid smoothing is a Gaussian set in mm on the model (`MapSpec.smoothMm`, default `MAP_SMOOTH_MM`). Preview builds keep the 4 mm profile. Measure with `npx tsx scripts/curve-audit.ts`; `test/curve-quality.test.ts` holds the acceptance numbers.

Map grid size (`mapGridSize`, mapProject.ts): with **Ground resolution** empty (`resM` 0, auto) EA LiDAR is cut at **0.5 mm per cell** on the model up to **1024 px** (the WCS `SCALEFACTOR` and the GeoTIFF decode are sized to match); Terrarium and any fallback stay at 8 m and **512 px**. A typed Ground resolution is used as given within those caps. 2048 px is for cloud jobs only. Project files are written compact (no pretty-printing) and engrave paths are rounded to 0.1 px so a 1024 px project stays under 4 MB. Measure with `npx tsx scripts/bench-map-resolution.ts`; `test/map-resolution.test.ts` holds the acceptance checks.

One pixel convention: `GridTransform.originX/Y` is the **centre** of cell (0, 0) (GeoTIFF edge origins are shifted by half a pixel on read), and face u/v run 0..1 across the outer edges of the map, so cell i's centre is at (i + 0.5) / w, the same frame as the OSM engrave art. UTM zones are 6° wide.

Map faces always stack **along the length**: `sliceAxis: 'width'` transposes the north-up frame (a mirror), so `mapFaceParams` evaluates map projects with `length` and the slicer adds a warning. Enforced by `test/map-correctness.test.ts` (corner hills read from plate planes, not `hf.at`).

Tests: `test/map-plate-height.test.ts`, `test/map-orient.test.ts`, `e2e/neasden-map.spec.ts` (fixtures), `LIVE_MAP=1 npm run e2e:live`.

### Manual overrides must not be clobbered

When the user sets a value explicitly, automatic pipelines must **not** overwrite it unless the user chooses **Reset to auto** (depth) or clears the override.

| Area | Storage | Auto systems that must respect overrides | Tests |
|------|---------|------------------------------------------|-------|
| Depth **near** / **far** (and curve, flatten, spacing, matte) | `DepthData.settings` + `DepthData.settingsOverrides` | Map terrain rebuild (`finishMapTerrainBuild`), new depth from services | `test/store-depth-overrides.test.ts`, `e2e/depth-near-far.spec.ts` |
| Master **size** preset (outline mm) | `Project.userParamOverrides` on `baseWidth`, `baseLength`, `masterScale` | Design parser `masterSize` patch | `test/store-depth-overrides.test.ts` |
| **Tuning** / plate params from auto-dimension | `Project.userParamOverrides` per param id | Design parser `autoDimension` patch | `test/store-depth-overrides.test.ts` |

**Depth:** `setDepthSettings` marks `settingsOverrides` for each field the user changes. `mergeDepthAfterRebuild` applies those settings on top of freshly built metric depth. **Reset to auto** clears override flags and restores values from `nearM` / `farM`. User-set near/far always win on **image and map** faces. Auto fills them only when unset or after Reset to auto.

Breaking commit for near/far (map rebuild wiping settings): `2463090` (`finishMapTerrainBuild` replaced the whole top asset, including `depth.settings`).

### Map live network (dev / preview)

Vite dev and preview serve `/api/ea-proxy` and `/api/overpass` so browser map builds work without fixtures. Opt-in live smoke: `LIVE_MAP=1 npm run e2e:live`. Do not edit `api/` in map-P0 work (separate hotfix).

### Playwright e2e port and CI

`playwright.config.ts` and `playwright.live.config.ts` share `playwright.env.ts` for **`STRATA_E2E_PORT`** (default **4173**) on both `baseURL` and `webServer` (`vite preview --strictPort`). Fixture e2e: `reuseExistingServer` is **false when `CI` is set** (a leftover preview on 4173 is never reused). Live (`LIVE_MAP=1 npm run e2e:live`, and `LIVE_MAP=1` on the fixture config): **never** reuses an existing server, CI or not. Occupied default port: `CI=1 STRATA_E2E_PORT=4199 npm run e2e`.

### UI smoke + accessibility (WCAG 2.2 AA)

`npm run e2e:smoke` runs `e2e/ui-smoke.spec.ts` (every workspace tab, every parameter group fold, toolbar menus, a preset, no page errors) and `e2e/a11y.spec.ts` (axe-core on every workspace tab in Paper, Dusk and Ink, plus keyboard tabs). Rules for new UI:
- Tabs: use `Tab` from `src/ui/Tab.tsx` (li is the focusable tab, inner `a` has no href; arrows/Home/End move). Never put a focusable control inside a tab; a close ✕ is `tabIndex={-1}` with a keyboard shortcut instead.
- Text on silver (`#c0c0c0`) or on white sunken lists/tables gets the silver-safe `--muted/--ok/--warn/--err` from `form-chrome.css`; add new silver containers to that selector rather than hard-coding greys. Themed surfaces (`.view`, panels) use `--ink`/`--muted`.
- `target-size` is deliberately not checked: the 18px 98.css icon buttons are the look.

### The engine runs in a Web Worker

The app builds every model in `src/core/engine.worker.ts` (front and deferred stages, plus each part's 3D mesh); `src/core/engine.ts` posts only changed project fields and assets, and replies carry only what changed, so unchanged parts keep their identity on the page. While a pointer is down the worker builds a coarse **preview** (`PREVIEW_SAMPLE_STEP`, no shadow carve, deferred stages stale); the full model follows 150 ms after release. Do not add heavy work to the page side: geometry belongs in `src/core` and runs in the worker. `createPipeline` stays for `src/cli.ts`, `CompareView` and `libraryDescribe`; exports use the on-screen model when it is full and current, else build on the page. A model on the page has a height field without `at()`; sample heights inside the pipeline. `e2e/engine-drag.spec.ts` checks no page task over 50 ms during a 10 s drag (93 plates; Shadow with 8 frames).

**Result cache.** A full build is kept by a 128-bit key over the engine version (`__STRATA_ENGINE__`, a hash of `src/core` and `package-lock.json` from `scripts/engine-hash.ts`), every project field except `UNKEYED_FIELDS` (name, locks, variants, composition, savedView) and the decoded assets (`src/core/resultCache.ts`). The worker answers undo, redo and reopened designs from memory or IndexedDB `strata-render-cache` (300 MB, least recently used out; off under `vite dev`); `main.tsx` preloads the session's model so a reload doesn't slice on the page; Compare reads and fills it; Settings › Clear saved results empties it. Never cache a preview, a model with the carve still running, or one built after a map failure. A new engine setting needs nothing extra as long as it lives in the project (params or another keyed field); anything else the engine reads must go into `resultKey`.

**Shadow worker.** The carve runs in `src/core/shadow.worker.ts` (`shadowJob.ts`), talking to the engine worker over its own MessageChannel. A full build that needs a carve replies at once with uncarved plates (`carving: true`, model stale), and again with the carved model when it lands. `carveShadowSteps` yields after each light, plate and frame so a newer carve (or a drag starting) stops the old one; `carveShadow` runs it straight through for the CLI and the page.

### Boost (cloud jobs) is opt-in and local stays complete

Boost (Settings, `strata.boost` in localStorage) is **off by default**. With it off the app makes **no `/api/geo` request** and does everything locally; every cloud call goes through `geoFetch` in `src/state/cloud.ts`, which refuses while Boost is off (`test/cloud-terrain.test.ts`, `e2e/boost.spec.ts`). The cloud runs the **same engine**: `worker/job.ts` bundles `src/core` (`npx tsx worker/build.ts`) with the same engine hash as the app (`scripts/engine-hash.ts`), and refuses a job from another build. Job keys hash the engine and the request (`api/_lib/geoJob.ts`). The terrain job is `buildMapBundle` with `maxPx` 2048 (`MAP_CLOUD_MAX_PX`, fine sources only); any cloud failure falls back to the local build with a toast. Cloud-built grids are saved as a 1024 px copy (`compactCloudAsset`). Every `/api/geo` route checks the owner passphrase before any Modal or Blob call. Secrets (`MODAL_KEY`, `MODAL_SECRET`, `RENDER_CACHE_READ_WRITE_TOKEN`) live only in Vercel / Modal env, never `VITE_`-prefixed. See `docs/cloud-jobs.md`.

### Table or wall: only the view turns

Display › Shown on (`mount`: table | wall, plus `wallTop` for a wall piece) never changes the model. Plates, nests, DXFs and the build pack are identical either way; model coordinates stay +Y up from the base. `src/core/mount.ts` (`mountFrame(v, map)`) says which way is really up (`up`), towards the viewer (`toward`), and the bearing Sun › Front faces refers to (`facing`), all in model coordinates; `roomToModel` / `modelToRoom` / `modelToRoomMatrix` turn between them. A wall piece hangs with the underside of its base on the wall (room z = 0), so model +Y points into the room. The 3D view keeps the scene in model coordinates and turns the camera, orbit axis (`useOrbitUp`), lights and sun instead, so gizmos, picking and measuring need nothing. Hero renders and AR are turned into the room (`HeroScene.room`, a `wall` mesh Blender keeps out of the bounds). Shelves, candles and anything else that cares about gravity should read `mountFrame(v).up`, not assume +Y.

Building on a wall: placed objects, candelabra candles and shelf cards keep their **positions** on the piece (model coordinates, the same spots on its face as on a table) but their **turns** are measured in the room: `toWorld` stands them upright (`standUpright`, from the `room` frame `originFrame` carries for a wall piece). Candles and shelf cards then drop onto the plate below them (`restOnWall` in `src/core/wallBuild.ts`: a level plate's top face or an upright plate's top edge), against the plates sliced without them ('Plates to stand on' stage). On a wall, candles are cups through the plates with a hidden `flameN` chimney cutter above each flame; fins, wells, pads, chokes and plate-top seats are table-only (`forWall` strips them). Display › Plates run (`wallPlates`: across | down, only with the top picture at the top) picks which way the plates hang: across lies them level, stacked up the wall; down hangs them vertically. Down makes `up` the picture's old right (`wallUp`) and `applySwitches` adds a quarter turn to `topRotate` so the picture still reads upright (raw-params readers use `pictureTurn`). `test/mount.test.ts`, `e2e/mount.spec.ts`.

## 3D skills (all agents)

`.claude/skills/` holds vendored three.js / React Three Fiber guidance (sources and pinned commits in `.claude/skills/README.md`). Claude Code loads them automatically. Cursor, Grok and other agents: before changing 3D code (`src/ui/Viewport*.tsx`, `ViewFromPoint.tsx`, anything using `three` or `@react-three/*`), read the matching `SKILL.md`:

- Scene setup, render loop, ownership: `r3f-fundamentals`. Geometry, instancing: `r3f-geometry`. Materials: `r3f-materials`. Lights and shadows: `r3f-lighting`. Textures: `r3f-textures`. Loading: `r3f-loaders`. Pointer, drag, controls: `r3f-interaction`. Shaders: `r3f-shaders`. Animation: `r3f-animation`.
- Performance and disposal checklists: `three-best-practices` (plain three, including `src/core` geometry) and `r3f-best-practices`.

Strata's own invariants above win where they disagree with a skill.
