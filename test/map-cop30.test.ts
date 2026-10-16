import { describe, expect, it } from 'vitest';
import { COPERNICUS_DEM30_BASE } from '../src/core/mapCopernicus';
import { loadBuiltinCop30Fixture } from '../src/core/mapCopernicus.fixtures';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('map Copernicus GLO-30 (T5)', () => {
  it('loads offline cop30 fixture grid', () => {
    const g = loadBuiltinCop30Fixture();
    expect(g?.w).toBeGreaterThan(4);
    expect(g?.data.length).toBe(g!.w * g!.h);
  });

  it('builds map bundle from cop30 fixture without terrarium fallback warning', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_FAST_BBOX,
        source: 'cop30',
        engrave: { enabled: false, features: [] },
        layerBudget: 'equal',
        resM: 32,
      }),
      {
        fetch: fixtureTileFetcher,
        cop30Loader: async () => loadBuiltinCop30Fixture(),
        stack: { plateCount: 4, thicknessMm: 3, masterWidthMm: 120, layerBudget: 'equal' },
      },
    );
    expect(bundle.asset.map?.resolvedSource).toBe('cop30');
    expect(bundle.asset.map?.sourceWarnings?.some((w) => /falling back to terrarium/i.test(w))).toBeFalsy();
    setMapTileFetcher(null);
  });

  it('documents the AWS COG base URL', () => {
    expect(COPERNICUS_DEM30_BASE).toMatch(/copernicus-dem-30m/);
  });
});
