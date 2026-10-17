import { describe, expect, it } from 'vitest';
import { applyLayerBudget, computeLayerBreaks } from '../src/core/mapLayerBudget';
import { mapDepthToGray } from '../src/core/mapPlateHeight';
import { buildMapBundle } from '../src/core/mapPipeline';
import { metricBounds, reprojectResample } from '../src/core/mapProject';
import { defaultMapSpec } from '../src/core/mapSpec';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { restoreSummitCells, simplifyMetricGrid } from '../src/core/mapSimplify';
import { countPlatesAtMaxHeight } from '../src/core/slicer';
import type { Float32Grid } from '../src/core/mapGrid';
import { gridFiniteMinMax } from '../src/core/mapGrid';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

const PEAKS = [
  { u: 0.18, v: 0.16, z: 851.1, name: 'grasmoor' },
  { u: 0.82, v: 0.22, z: 839, name: 'crag' },
  { u: 0.48, v: 0.84, z: 807, name: 'stile' },
] as const;

function threePeakDem(): { grid: Float32Grid; peaks: { name: string; z: number; x: number; y: number }[] } {
  const b = metricBounds(NEASDEN_FAST_BBOX, 'EPSG:27700');
  const w = 72;
  const h = 72;
  const pixelW = (b.east - b.west) / w;
  const pixelH = (b.north - b.south) / h;
  const data = new Float32Array(w * h);
  const peaks = PEAKS.map((p) => ({
    name: p.name,
    z: p.z,
    x: b.west + p.u * (b.east - b.west),
    y: b.south + p.v * (b.north - b.south),
  }));
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const u = col / (w - 1);
      const v = row / (h - 1);
      let z = 143 + 8 * Math.sin(col / 5) * Math.cos(row / 6);
      for (const p of PEAKS) {
        const d = Math.hypot((u - p.u) * 4.2, (v - p.v) * 4.2);
        const spike = p.z * Math.max(0, 1 - d);
        if (spike > z) z = spike;
      }
      data[row * w + col] = z;
    }
  }
  for (const p of peaks) {
    const col = Math.round((p.x - (b.west + pixelW / 2)) / pixelW);
    const row = Math.round((p.y - (b.south + pixelH / 2)) / pixelH);
    if (col >= 0 && row >= 0 && col < w && row < h) data[row * w + col] = p.z;
  }
  return {
    grid: {
      w,
      h,
      data,
      crs: 'EPSG:27700',
      transform: { originX: b.west + pixelW / 2, originY: b.south + pixelH / 2, pixelW, pixelH },
    },
    peaks,
  };
}

describe('map summit export: DEM max and distinct peaks', () => {
  it('final plates keep the DEM max and three distinct summits', async () => {
    const { grid, peaks } = threePeakDem();
    const rawMax = gridFiniteMinMax(grid.data).max;
    expect(rawMax).toBeCloseTo(851.1, 4);

    const spec = defaultMapSpec({
      bbox: NEASDEN_FAST_BBOX,
      source: 'ea-dtm',
      water: 'raw',
      exaggeration: 4,
      layerBudget: 'jenks',
      engrave: { enabled: false, features: [] },
      resM: 8,
    });
    const raw = reprojectResample(grid, spec);
    const land = computeLayerBreaks(raw, 12, 'jenks');
    expect(land.breaksM[land.breaksM.length - 1]!).toBeCloseTo(gridFiniteMinMax(raw.data).max, 3);

    const bundle = await buildMapBundle(spec, {
      eaLoader: async () => grid,
      allowOverpassNetwork: false,
      fetch: async () => {
        throw new Error('summit-export test must not mosaic tiles');
      },
      stack: { plateCount: 12, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' },
    });

    const snappedMax = gridFiniteMinMax(bundle.metric.data).max;
    expect(snappedMax).toBeCloseTo(rawMax, 0);
    expect(Math.abs(snappedMax - rawMax)).toBeLessThan(2);
    expect(bundle.depth.mapOrtho?.zMaxM).toBeCloseTo(snappedMax, 3);

    const heights = peaks.map((p) => {
      const t = bundle.metric.transform;
      const col = Math.round((p.x - t.originX) / t.pixelW);
      const row = Math.round((p.y - t.originY) / t.pixelH);
      let best = -Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const c = col + dx;
          const r = row + dy;
          if (c < 0 || r < 0 || c >= bundle.metric.w || r >= bundle.metric.h) continue;
          const z = bundle.metric.data[r * bundle.metric.w + c]!;
          if (z > best) best = z;
        }
      }
      return { name: p.name, want: p.z, got: best };
    });
    const byName = Object.fromEntries(heights.map((h) => [h.name, h.got]));
    expect(byName.grasmoor).toBeGreaterThan(byName.crag + 2);
    expect(byName.crag).toBeGreaterThan(byName.stile + 2);
    expect(byName.grasmoor).toBeCloseTo(snappedMax, 0);

    const p = newProject();
    p.params = {
      ...p.params,
      plateCount: '12',
      thickness: '3',
      baseLength: '520',
      baseWidth: '380',
      stackHeight: '220',
      insShape: 'none',
      topDepth: '40',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
    };
    p.images.top = bundle.asset;
    const gray = mapDepthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(countPlatesAtMaxHeight(m.sliced.plates)).toBeLessThan(3);
  });

  it('simplify does not pull a narrow summit off the DEM max', () => {
    const { grid } = threePeakDem();
    const breaks = computeLayerBreaks(grid, 12, 'jenks').breaksM;
    const snapped = applyLayerBudget(grid, breaks);
    const before = gridFiniteMinMax(snapped.data).max;
    const simplified = simplifyMetricGrid(snapped, { kerfMm: 0.2, pixelSizeM: 10, minIslandAreaPx: 8 });
    const restored = restoreSummitCells(simplified.grid, snapped);
    expect(gridFiniteMinMax(restored.data).max).toBeCloseTo(before, 4);
  });
});
