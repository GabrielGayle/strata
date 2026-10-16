# Agent guide — Strata

## Invariants

These rules are non-negotiable. Regressions are guarded by unit tests and Playwright e2e.

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

`mapGridToDepth` stores true min/max elevation. `buildMapHeightField` samples those metres (windowed only by user near/far) and sets plate heights. Auto exaggeration may still use a robust (p98−p2) estimate to pick the **factor**; the Map readout and plate maths both use **true** `(max − min)` metres (`mapOrtho.reliefM`). A map top face does not keep the default insert (Vermilion fin). The 3D caption on a map face is **terrain lo–hi mm** from cut-outline vertices above the concrete (`plateOutlineYRangeMm`), not each plate’s bounding-box top (that old “plate height 45–150 mm” band ignored valleys on the same plate).

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
