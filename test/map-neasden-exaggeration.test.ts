import { describe, expect, it } from 'vitest';
import { computeAutoExaggeration } from '../src/core/mapExaggeration';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapNoticesMatching } from '../src/core/mapNotices';
import { loadBuiltinEaFixture } from '../src/core/mapEaLidar.fixtures';
import { mapPresetSpec } from '../src/core/mapPresets';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('Neasden auto exaggeration', () => {
  it('plan stack-height formula lands near ×18–21 for A3 (420 mm) with 30×3 mm plates', () => {
    const factor = computeAutoExaggeration({
      reliefM: 35,
      stackHeightMm: 90,
      mapWidthM: 3250,
      masterWidthMm: 420,
    });
    expect(factor).toBeGreaterThanOrEqual(18);
    expect(factor).toBeLessThanOrEqual(21);
  });

  it('buildMapBundle auto lands near ×18–21 for Neasden EA clip (not layer-budget ×50 clamp)', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        ...mapPresetSpec('neasden'),
        bbox: NEASDEN_FAST_BBOX,
        source: 'ea-dtm',
        engrave: { enabled: false, features: [] },
      }),
      {
        fetch: fixtureTileFetcher,
        eaLoader: async () => loadBuiltinEaFixture(),
        allowOverpassNetwork: false,
        stack: { plateCount: 30, thicknessMm: 3, masterWidthMm: 420, layerBudget: 'jenks' },
      },
    );
    const factor = bundle.asset.map?.exaggerationFactor;
    expect(factor).toBeGreaterThan(15);
    expect(factor).toBeLessThanOrEqual(21);
    expect(factor).not.toBe(50);
    expect(mapNoticesMatching(bundle.asset.map?.sourceWarnings, /bathymetry/i, 'info')).toBe(true);
    setMapTileFetcher(null);
  });
});
