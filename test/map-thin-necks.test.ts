import { describe, expect, it } from 'vitest';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapPresetSpec, NEASDEN_MAP_BBOX } from '../src/core/mapPresets';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { mapDepthToGray } from '../src/core/mapPlateHeight';

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

async function neasdenAt(exaggeration: number) {
  const grid = liveLikeNeasdenGrid();
  const bundle = await buildMapBundle(
    defaultMapSpec({
      ...mapPresetSpec('neasden'),
      bbox: NEASDEN_MAP_BBOX,
      source: 'ea-dtm',
      water: 'raw',
      exaggeration,
      layerBudget: 'jenks',
      engrave: { enabled: false, features: [] },
    }),
    {
      eaLoader: async () => grid,
      allowOverpassNetwork: false,
      stack: { plateCount: 40, thicknessMm: 3, masterWidthMm: 800, layerBudget: 'jenks' },
    },
  );
  const p = newProject();
  p.params = {
    ...p.params,
    baseLength: '800',
    baseWidth: '300',
    plateCount: '40',
    thickness: '3',
    stackHeight: '220',
    erosionAmp: '45',
    insShape: 'none',
  };
  p.images.top = bundle.asset;
  const gray = mapDepthToGray(bundle.depth);
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
  return { p, m, factor: bundle.asset.map?.exaggerationFactor };
}

describe('Neasden thin-neck min-feature pass', () => {
  it.each([11, 21])('×%s default mode has no “narrower than 2 mm” warnings', async (ex) => {
    const { p, m, factor } = await neasdenAt(ex);
    expect(factor).toBe(ex);
    expect(m.v.minFeature).toBe(2);
    expect(p.params.minFeature ?? '2').not.toBe('1');
    const thin = m.issues.filter((i) => i.type === 'thin' && /narrower than 2 mm/.test(i.message));
    expect(thin).toHaveLength(0);
    expect(m.sliced.plates.length).toBe(40);
  });

  it('keep mode can still report thin necks; user minFeature is left alone', async () => {
    const grid = liveLikeNeasdenGrid();
    const bundle = await buildMapBundle(
      defaultMapSpec({
        ...mapPresetSpec('neasden'),
        bbox: NEASDEN_MAP_BBOX,
        source: 'ea-dtm',
        water: 'raw',
        exaggeration: 21,
        layerBudget: 'jenks',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => grid,
        allowOverpassNetwork: false,
        stack: { plateCount: 40, thicknessMm: 3, masterWidthMm: 800, layerBudget: 'jenks' },
      },
    );
    const p = newProject();
    p.params = {
      ...p.params,
      baseLength: '800',
      baseWidth: '300',
      plateCount: '40',
      thickness: '3',
      stackHeight: '220',
      erosionAmp: '45',
      insShape: 'none',
      fragmentMode: 'keep',
      minFeature: '2',
    };
    p.images.top = bundle.asset;
    const gray = mapDepthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.v.fragmentMode).toBe('keep');
    expect(m.v.minFeature).toBe(2);
    expect(p.params.minFeature).toBe('2');
    expect(p.params.fragmentMode).toBe('keep');
  });
});
