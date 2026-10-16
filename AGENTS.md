# Agent guide — Strata

## Invariants

These rules are non-negotiable for automated changes and reviews. Regressions are guarded by unit tests and Playwright e2e where noted.

### Manual overrides must not be clobbered

When the user sets a value explicitly, automatic pipelines must **not** overwrite it unless the user chooses **Reset to auto** (depth) or clears the override.

| Area | Storage | Auto systems that must respect overrides | Tests |
|------|---------|------------------------------------------|-------|
| Depth **near** / **far** (and curve, flatten, spacing, matte) | `DepthData.settings` + `DepthData.settingsOverrides` | Map terrain rebuild (`finishMapTerrainBuild`), new depth from services | `test/store-depth-overrides.test.ts`, `e2e/depth-near-far.spec.ts` |
| Master **size** preset (outline mm) | `Project.userParamOverrides` on `baseWidth`, `baseLength`, `masterScale` | Design parser `masterSize` patch | `test/store-depth-overrides.test.ts` |
| **Tuning** / plate params from auto-dimension | `Project.userParamOverrides` per param id | Design parser `autoDimension` patch | `test/store-depth-overrides.test.ts` |
| Map **exaggeration** when user picks a fixed factor | `MapSpec.exaggeration` (non-`auto`) | Map pipeline should not force `auto` back without user action | (extend tests when UI exposes this) |

**Depth:** `setDepthSettings` marks `settingsOverrides` for each field the user changes. `mergeDepthAfterRebuild` applies those settings on top of freshly built metric depth. **Reset to auto** clears override flags and restores values from `nearM` / `farM` via `resetDepthSettingsToAuto`.

**Params:** `setParam` / `setParams` mark `userParamOverrides`. `applyProjectPatch` skips `masterSize` when outline params are overridden and merges auto-dimension patches with `applyParamPatchRespectingOverrides`.

### Map live network (dev / preview)

Vite dev and preview serve `/api/ea-proxy` and `/api/overpass` so browser map builds work without fixtures. Opt-in live smoke: `LIVE_MAP=1 npm run e2e:live`.
