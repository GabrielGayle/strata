import { afterEach, describe, expect, it } from 'vitest';
import { computeAutoExaggeration, exaggerationReadout, resolveExaggerationFactor } from '../src/core/mapExaggeration';
import { computeLayerBreaks, equalBreaks, jenksBreaks, quantileBreaks, applyLayerBudget } from '../src/core/mapLayerBudget';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { mapDepthToGray } from '../src/core/mapPlateHeight';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { NEASDEN_FAST_BBOX } from './map-fixtures';
import { setMapTileFetcher } from '../src/core/mapTerrarium';

afterEach(() => {
  setMapTileFetcher(null);
});

/** Tiny cone on the fast Neasden clip — no tile mosaic, cheap Jenks. */
function tinyNeasdenCone(): Float32Grid {
  const b = metricBounds(NEASDEN_FAST_BBOX, 'EPSG:27700');
  const w = 16;
  const h = 16;
  const pixelW = (b.east - b.west) / w;
  const pixelH = (b.north - b.south) / h;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1) - 0.5;
      const v = y / (h - 1) - 0.5;
      data[y * w + x] = 8 + 22 * Math.max(0, 1 - 2 * Math.hypot(u, v));
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: b.west + pixelW / 2, originY: b.north - pixelH / 2, pixelW, pixelH: -pixelH },
  };
}

describe('map layer budget + exaggeration', () => {
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
    const grid = tinyNeasdenCone();
    const budget = computeLayerBreaks(grid, 12, 'jenks');
    expect(budget.breaksM.length).toBe(12);
    const snapped = applyLayerBudget(grid, budget.breaksM);
    const { factor, readout } = resolveExaggerationFactor({ exaggeration: 'auto' }, snapped, {
      plateCount: 12,
      thicknessMm: 3,
      masterWidthMm: 520,
    });
    expect(factor).toBeGreaterThanOrEqual(1);
    expect(readout).toMatch(/^×/);

    const bundle = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_FAST_BBOX,
        source: 'ea-dtm',
        exaggeration: 'auto',
        water: 'raw',
        layerBudget: 'jenks',
        engrave: { enabled: false, features: [] },
        resM: 64,
      }),
      {
        eaLoader: async () => grid,
        allowOverpassNetwork: false,
        fetch: async () => {
          throw new Error('layer-budget test must not mosaic tiles');
        },
        stack: { plateCount: 12, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' },
      },
    );
    expect(bundle.asset.map?.layerBreaksM?.length).toBe(12);
    expect(bundle.asset.map?.exaggerationReadout).toMatch(/^×/);

    const p = newProject();
    p.params = { ...p.params, plateCount: '12', insShape: 'none', topDepth: '40' };
    p.images.top = bundle.asset;
    const gray = mapDepthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.sliced.plates.length).toBe(12);
  });

  it('quantile and equal modes return the requested break count', () => {
    const vals = Array.from({ length: 100 }, (_, i) => i);
    expect(quantileBreaks(vals, 8).length).toBe(8);
    expect(equalBreaks(0, 99, 8).length).toBe(8);
  });
});
