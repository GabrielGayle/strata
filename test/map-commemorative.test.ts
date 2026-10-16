import { describe, expect, it } from 'vitest';
import { commemorativeFitWarning, mapBackPlateEtchPaths } from '../src/core/mapBackPlateEtch';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_FAST_BBOX } from './map-fixtures';
import type { Part } from '../src/core/slicer';

const plate: Part = {
  id: 'P1',
  plateKey: 'P1',
  family: 'P',
  index: 0,
  piece: 0,
  plane: { origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 1, 0] },
  thickness: 3,
  shape: [{ outer: [[0, 0], [120, 0], [120, 80], [0, 80], [0, 0]], holes: [] }],
  etch: [],
  labelPaths: [],
  labelAt: null,
  area: 9600,
  perimeter: 400,
  bbox: { minX: 0, minY: 0, maxX: 120, maxY: 80 },
  anchored: true,
  kind: 'plate',
};

describe('map commemorative text (T26)', () => {
  it('warns when text is too wide for the back plate', () => {
    const long = 'A'.repeat(200);
    expect(commemorativeFitWarning(long, 120)).toMatch(/does not fit/i);
    expect(commemorativeFitWarning('Fore!', 120)).toBeNull();
  });

  it('etches short commemorative text on the back plate', () => {
    const paths = mapBackPlateEtchPaths(
      plate,
      defaultMapSpec({ bbox: NEASDEN_FAST_BBOX, commemorativeText: 'Opened 2026' }),
    );
    expect(paths.length).toBeGreaterThan(0);
  });

  it('records a warning on MapSpec when text does not fit', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_FAST_BBOX,
        source: 'terrarium',
        engrave: { enabled: false, features: [] },
        commemorativeText: 'X'.repeat(180),
      }),
      { fetch: fixtureTileFetcher, stack: { plateCount: 4, thicknessMm: 3, masterWidthMm: 80, layerBudget: 'equal' } },
    );
    expect(bundle.asset.map?.sourceWarnings?.some((w) => /commemorative/i.test(w.message))).toBe(true);
    setMapTileFetcher(null);
  });
});
