import { describe, expect, it } from 'vitest';
import { buildMapBundle } from '../src/core/mapPipeline';
import { EA_LIDAR_DSM_CATALOG, EA_LIDAR_DTM_CATALOG } from '../src/core/mapEaLidar';
import { loadBuiltinEaFixture } from '../src/core/mapEaLidar.fixtures';
import { defaultMapSpec } from '../src/core/mapSpec';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('map EA LiDAR (T6)', () => {
  it('loads offline Neasden 1 m fixture', () => {
    const g = loadBuiltinEaFixture();
    expect(g?.crs).toBe('EPSG:27700');
    const min = Math.min(...g!.data);
    const max = Math.max(...g!.data);
    expect(min).toBeGreaterThanOrEqual(28);
    expect(max).toBeLessThanOrEqual(68);
  });

  it('builds map bundle from ea-dtm fixture without terrarium fallback warning', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_FAST_BBOX,
        source: 'ea-dtm',
        engrave: { enabled: false, features: [] },
        layerBudget: 'equal',
        resM: 32,
      }),
      {
        fetch: fixtureTileFetcher,
        eaLoader: async () => loadBuiltinEaFixture(),
        stack: { plateCount: 4, thicknessMm: 3, masterWidthMm: 120, layerBudget: 'equal' },
      },
    );
    expect(bundle.asset.map?.resolvedSource).toBe('ea-dtm');
    expect(bundle.asset.map?.sourceWarnings?.some((w) => /falling back to terrarium/i.test(w.message))).toBeFalsy();
    setMapTileFetcher(null);
  });

  it('documents the live EA DTM WCS URL (not the retired DefraDataDownload catalog)', () => {
    expect(EA_LIDAR_DTM_CATALOG).toMatch(/environment\.data\.gov\.uk\/geoservices\/datasets\/.+\/wcs/);
    expect(EA_LIDAR_DSM_CATALOG).toMatch(/environment\.data\.gov\.uk\/geoservices\/datasets\/.+\/wcs/);
    expect(EA_LIDAR_DTM_CATALOG).not.toMatch(/DefraDataDownload/);
    expect(EA_LIDAR_DSM_CATALOG).not.toMatch(/DefraDataDownload/);
  });
});
