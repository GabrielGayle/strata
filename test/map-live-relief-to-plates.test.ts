import { describe, expect, it } from 'vitest';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapPresetSpec, NEASDEN_MAP_BBOX } from '../src/core/mapPresets';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { mapDepthToGray, mapTrueRangePlateMm } from '../src/core/mapPlateHeight';
import { plateTopHeightRangeMm } from '../src/core/slicer';

/** Live EA Neasden-like DEM: valley ~35 m, peak 86 m, dip 18.8 m. */
function liveLikeNeasdenGrid(): Float32Grid {
  const b = metricBounds(NEASDEN_MAP_BBOX, 'EPSG:27700');
  const w = 96;
  const h = 96;
  const pixelW = (b.east - b.west) / w;
  const pixelH = (b.north - b.south) / h;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      let z = 35 + 4 * Math.sin(u * 8) * Math.cos(v * 6);
      const hill = Math.exp(-((u - 0.75) ** 2 + (v - 0.8) ** 2) / 0.04);
      const dip = Math.exp(-((u - 0.2) ** 2 + (v - 0.2) ** 2) / 0.05);
      z = z + hill * (86 - z) + dip * (18.8 - z);
      data[y * w + x] = z;
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: {
      originX: b.west + pixelW / 2,
      originY: b.south + pixelH / 2,
      pixelW,
      pixelH,
    },
  };
}

function gridMinMax(g: Float32Grid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const z of g.data) {
    if (!Number.isFinite(z)) continue;
    min = Math.min(min, z);
    max = Math.max(max, z);
  }
  return { min, max };
}

describe('live-scale EA relief must reach plate tops', () => {
  it('Vermilion 40 plates span ~ stackHeightMm, not a ~32 mm strata band', async () => {
    const grid = liveLikeNeasdenGrid();
    const bundle = await buildMapBundle(
      defaultMapSpec({
        ...mapPresetSpec('neasden'),
        bbox: NEASDEN_MAP_BBOX,
        source: 'ea-dtm',
        water: 'raw',
        exaggeration: 'auto',
        layerBudget: 'jenks',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => grid,
        allowOverpassNetwork: false,
        stack: { plateCount: 40, thicknessMm: 3, masterWidthMm: 800, layerBudget: 'jenks' },
      },
    );

    const raw = gridMinMax(grid);
    const metric = gridMinMax(bundle.metric);
    const depthRelief = bundle.depth.mapOrtho?.reliefM ?? 0;
    const factor = bundle.asset.map?.exaggerationFactor ?? 0;

    const p = newProject();
    p.params = {
      ...p.params,
      baseLength: '800',
      baseWidth: '300',
      plateCount: '40',
      thickness: '3',
      stackHeight: '220',
      erosionAmp: '45',
    };
    p.images.top = bundle.asset;
    const gray = mapDepthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    const expected = mapTrueRangePlateMm(bundle.depth, m.v, factor);
    const actual = plateTopHeightRangeMm(m.sliced.plates);
    const hfSpan = (m.hf?.max ?? 0) - (m.hf?.min ?? 0);

    // 45 m ×11 on 800 mm / ~3.3 km → ~120 mm. A 32 mm band is the old leak.
    expect(factor).toBeGreaterThanOrEqual(8);
    expect(depthRelief).toBeGreaterThan(raw.max - raw.min - 5);
    expect(metric.max - metric.min).toBeGreaterThan((raw.max - raw.min) * 0.7);
    expect(expected).toBeGreaterThan(80);
    expect(hfSpan).toBeGreaterThan(80);
    expect(m.hf?.min).toBeLessThan(20); // map floor (~4 mm), not strata stackHeight 220
    expect(actual).toBeGreaterThan(80);
    expect(actual).toBeGreaterThan(expected * 0.7);
    expect(actual).toBeLessThan(expected * 1.3);
  });
});
