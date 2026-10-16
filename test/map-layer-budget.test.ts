import { afterEach, describe, expect, it } from 'vitest';
import { computeAutoExaggeration, exaggerationReadout, resolveExaggerationFactor } from '../src/core/mapExaggeration';
import { computeLayerBreaks, equalBreaks, jenksBreaks, quantileBreaks, applyLayerBudget } from '../src/core/mapLayerBudget';
import { syntheticConeGrid } from '../src/core/mapToDepth';
import { createPipeline } from '../src/core/pipeline';
import { depthToGray } from '../src/core/depth';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_FAST_BBOX } from './map-fixtures';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { smallProject } from './small-project';

describe('map layer budget + exaggeration', () => {
  afterEach(() => {
    setMapTileFetcher(null);
  });

  it('auto exaggeration matches the stack-height formula (Neasden example)', () => {
    const ex = computeAutoExaggeration({
      reliefM: 35,
      stackHeightMm: 90,
      mapWidthM: 3250,
      masterWidthMm: 400,
    });
    expect(ex).toBeGreaterThan(19);
    expect(ex).toBeLessThan(23);
    expect(exaggerationReadout(ex)).toBe('×20.9');
  });

  it('Jenks breaks differ from equal breaks on skewed data', () => {
    const skewed = [0, 0, 0, 0, 0, 1, 2, 3, 4, 50];
    const j = jenksBreaks(skewed, 3);
    const e = equalBreaks(0, 50, 3);
    expect(j.length).toBe(3);
    expect(j).not.toEqual(e);
  });

  it('produces N layer breaks and N flat-stack plates with auto exaggeration readout', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const grid = syntheticConeGrid(16, 24, 18);
    const budget = computeLayerBreaks(grid, 6, 'equal');
    expect(budget.breaksM.length).toBe(6);
    const snapped = applyLayerBudget(grid, budget.breaksM);
    const { factor, readout } = resolveExaggerationFactor({ exaggeration: 'auto' }, snapped, {
      plateCount: 6,
      thicknessMm: 3,
      masterWidthMm: 180,
    });
    expect(factor).toBeGreaterThanOrEqual(1);
    expect(readout).toMatch(/^×/);

    const spec = defaultMapSpec({
      bbox: NEASDEN_FAST_BBOX,
      source: 'terrarium',
      exaggeration: 'auto',
      layerBudget: 'equal',
      resM: 32,
      engrave: { enabled: false, features: [] },
    });
    const bundle = await buildMapBundle(spec, {
      fetch: fixtureTileFetcher,
      stack: { plateCount: 6, thicknessMm: 3, masterWidthMm: 180, layerBudget: 'equal' },
    });
    expect(bundle.asset.map?.layerBreaksM?.length).toBe(6);
    expect(bundle.asset.map?.exaggerationReadout).toMatch(/^×/);

    const p = smallProject({ imgTopMode: 'carve', topDepth: '40' });
    p.images.top = bundle.asset;
    const gray = depthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.sliced.plates.length).toBe(6);
  });

  it('quantile and equal modes return the requested break count', () => {
    const vals = Array.from({ length: 100 }, (_, i) => i);
    expect(quantileBreaks(vals, 8).length).toBe(8);
    expect(equalBreaks(0, 99, 8).length).toBe(8);
  });
});
