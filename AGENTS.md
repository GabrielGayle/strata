# Agent guide — Strata

## Invariants

These rules are non-negotiable. Regressions are guarded by unit tests and Playwright e2e.

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

`mapGridToDepth` stores true min/max elevation. `buildMapHeightField` samples those metres (windowed only by user near/far) and sets plate heights. Auto exaggeration may still use a robust (p98−p2) estimate to pick the **factor**; plate maths use **true** `(max − min)` metres (`mapOrtho.reliefM`). The Map tab live line and the 3D caption **share the built geometry** (`formatLiveMapReadout` contains `formatMapHeightCaption`): flat stack is **n × thickness**, upright map faces are **terrain lo–hi mm** from cut-outline vertices (`plateOutlineYRangeMm`). Do not show a plan-scale millimetre figure from another preset’s master width (Stamped 520 mm vs Vermilion 800 mm). A map top face does not keep the default insert (Vermilion fin).

The Map tab hillshade can look correct while 3D plates stay a ~32 mm band at `stackHeight` ± `erosionAmp` (live Neasden: 232–264 mm). That means the pipeline still used `buildHeightField` and never called `buildMapHeightField`.

Tests: `test/map-plate-height.test.ts`, `e2e/neasden-map.spec.ts` (fixtures), `LIVE_MAP=1 npm run e2e:live`.

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
