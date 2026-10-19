import { afterEach, describe, expect, it } from 'vitest';
import { computeAutoExaggeration, exaggerationReadout, resolveExaggerationFactor } from '../src/core/mapExaggeration';
import {
  computeLayerBreaks,
  equalBreaks,
  jenksBreaks,
  quantileBreaks,
  applyLayerBudget,
  injectPinnedBreaks,
  localBreakStep,
  localMaximaElevations,
} from '../src/core/mapLayerBudget';
import { MAX_SUMMIT_PINS, prominentSummitCells } from '../src/core/mapSummits';
import { gridFiniteMinMax } from '../src/core/mapGrid';
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
  it('auto exaggeration caps the A3 stack-fill example on low-relief London', () => {
    const ex = computeAutoExaggeration({
      reliefM: 35,
      stackHeightMm: 90,
      mapWidthM: 3250,
      masterWidthMm: 400,
    });
    expect(ex).toBeGreaterThan(2);
    expect(ex).toBeLessThan(3.2);
    expect(exaggerationReadout(ex)).toMatch(/^×2\.\d$/);
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

  it('adds lake surfaces on top of the budget and keeps the max-height class', () => {
    const clustered = [
      ...Array.from({ length: 80 }, () => 100.72),
      ...Array.from({ length: 80 }, () => 400),
      500,
    ];
    const jenks = jenksBreaks(clustered, 8);
    const pins = [98.67, 100.72, 493.39];
    const mixed = injectPinnedBreaks(jenks, pins, 8);
    expect(mixed.some((p) => Math.abs(p - 98.67) < 0.01)).toBe(true);
    expect(mixed.some((p) => Math.abs(p - 100.72) < 0.01)).toBe(true);
    expect(mixed.some((p) => Math.abs(p - 493.39) < 0.01)).toBe(true);
    for (const b of jenks) {
      expect(mixed.some((p) => Math.abs(p - b) < 0.05)).toBe(true);
    }
    expect(mixed.length).toBeGreaterThanOrEqual(new Set(jenks.map((b) => b.toFixed(2))).size);
    expect(Math.max(...mixed)).toBeCloseTo(Math.max(Math.max(...jenks), Math.max(...pins)), 5);
    const near = mixed.filter((p) => Math.abs(p - 98.67) < 0.05);
    expect(near).toHaveLength(1);
    expect(localBreakStep(400, jenks)).toBeGreaterThan(0);
  });

  it('last break is the true DEM max even when Jenks samples miss the peak cell', () => {
    const w = 80;
    const h = 80;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = 120 + (i % 17);
    data[3 * w + 5] = 851.1;
    data[3 * w + 6] = 848;
    data[60 * w + 70] = 839;
    data[60 * w + 69] = 836;
    data[40 * w + 20] = 807;
    data[40 * w + 21] = 804;
    const grid: Float32Grid = {
      w,
      h,
      data,
      crs: 'EPSG:27700',
      transform: { originX: 0, originY: 80, pixelW: 1, pixelH: -1 },
    };
    const { max } = gridFiniteMinMax(data);
    expect(max).toBeCloseTo(851.1, 3);
    const budget = computeLayerBreaks(grid, 12, 'jenks');
    expect(budget.breaksM[budget.breaksM.length - 1]).toBeCloseTo(851.1, 3);
    const snapped = applyLayerBudget(grid, budget.breaksM);
    expect(Math.max(...snapped.data.filter((z) => Number.isFinite(z)))).toBeCloseTo(851.1, 4);
    const peaks = localMaximaElevations(grid);
    expect(peaks.some((p) => Math.abs(p - 851.1) < 1)).toBe(true);
    const a = snapped.data[3 * w + 5]!;
    const b = snapped.data[60 * w + 70]!;
    const c = snapped.data[40 * w + 20]!;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(a - b).toBeGreaterThan(2);
    expect(b - c).toBeGreaterThan(2);
    expect(peaks.length).toBeLessThanOrEqual(MAX_SUMMIT_PINS);
  });

  it('caps summit cells to top-N bins on a noisy DEM', () => {
    const w = 256;
    const h = 256;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = 100 + (i % 23) + ((i * 13) % 11) * 0.3;
    data[8 * w + 8] = 851.1;
    data[200 * w + 40] = 839;
    data[40 * w + 200] = 807;
    const grid: Float32Grid = {
      w,
      h,
      data,
      crs: 'EPSG:27700',
      transform: { originX: 0, originY: h, pixelW: 1, pixelH: -1 },
    };
    const t0 = performance.now();
    const cells = prominentSummitCells(grid);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(MAX_SUMMIT_PINS);
    expect(Math.max(...cells.map((c) => c.z))).toBeCloseTo(851.1, 3);
    const zs = cells.map((c) => c.z);
    expect(zs.some((z) => Math.abs(z - 839) < 1)).toBe(true);
    expect(zs.some((z) => Math.abs(z - 807) < 1)).toBe(true);
  });

  it('floors water cells and never snaps them above the raw DEM', () => {
    const data = new Float32Array([95, 98.67, 100.72, 400]);
    const grid: Float32Grid = {
      w: 4,
      h: 1,
      data,
      crs: 'EPSG:27700',
      transform: { originX: 0, originY: 0, pixelW: 1, pixelH: -1 },
    };
    const breaks = [90, 98.67, 100.72, 400];
    const floorMask = new Uint8Array([1, 1, 0, 0]);
    const snapped = applyLayerBudget(grid, breaks, { floorMask, cap: data });
    expect(snapped.data[0]).toBeLessThanOrEqual(95);
    expect(snapped.data[0]).toBeCloseTo(90, 5);
    expect(snapped.data[1]).toBeCloseTo(98.67, 5);
    expect(snapped.data[2]).toBeCloseTo(100.72, 5);
    const ceiled = applyLayerBudget(grid, breaks);
    expect(ceiled.data[0]).toBeCloseTo(98.67, 5);
    expect(ceiled.data[0]).toBeGreaterThan(95);
  });
});
