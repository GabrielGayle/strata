import { beforeAll, describe, expect, it } from 'vitest';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapPresetSpec, NEASDEN_MAP_BBOX } from '../src/core/mapPresets';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { createPipeline } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { mapDepthToGray } from '../src/core/mapPlateHeight';
import { fetchEaLidarGrid } from '../src/core/mapEaLidar';

const live = process.env.LIVE_MAP === '1';

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

async function neasdenAt(
  exaggeration: number,
  opts: { stamped?: boolean; fragmentMode?: string; grid?: Float32Grid; water?: 'raw' | 'bathy'; overpass?: boolean } = {},
) {
  const stamped = !!opts.stamped;
  const plateCount = stamped ? 20 : 40;
  const grid = opts.grid ?? liveLikeNeasdenGrid();
  const bundle = await buildMapBundle(
    defaultMapSpec({
      ...mapPresetSpec('neasden'),
      bbox: NEASDEN_MAP_BBOX,
      source: 'ea-dtm',
      water: opts.water ?? 'raw',
      exaggeration,
      layerBudget: 'jenks',
      engrave: { enabled: false, features: [] },
    }),
    {
      eaLoader: async () => grid,
      allowOverpassNetwork: !!opts.overpass,
      stack: {
        plateCount,
        thicknessMm: 3,
        masterWidthMm: stamped ? 520 : 800,
        layerBudget: 'jenks',
      },
    },
  );
  let p = newProject();
  if (stamped) p = applyPreset(p, PRESETS.find((x) => x.name === 'Stamped stack')!);
  else {
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
  }
  if (opts.fragmentMode) p.params = { ...p.params, fragmentMode: opts.fragmentMode };
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
    expect(m.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(m.sliced.plates.length).toBe(40);
  });

  it.each([11, 21])('Stamped stack ×%s has no fit errors and still follows the map', async (ex) => {
    const { p, m, factor } = await neasdenAt(ex, { stamped: true });
    expect(factor).toBe(ex);
    expect(m.v.sliceMode).toBe('flat');
    expect(m.v.kerf).toBe(0.15);
    expect(m.v.minFeature).toBe(2);
    expect(p.params.kerf ?? '0.15').not.toBe('0.2');
    expect(m.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(m.issues.filter((i) => i.type === 'thin' && /narrower than 2 mm/.test(i.message))).toHaveLength(0);
    expect(m.sliced.plates.length).toBe(20);
    expect(m.sliced.parts.some((q) => q.area > 100)).toBe(true);
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

function issueTally(m: { issues: { severity: string; type: string; message: string; partId: string | null }[] }) {
  const errors = m.issues.filter((i) => i.severity === 'error');
  const warnings = m.issues.filter((i) => i.severity === 'warn');
  const thin = warnings.filter((i) => i.type === 'thin' && /narrower than 2 mm/.test(i.message));
  return { errors, warnings, thin };
}

describe.skipIf(!live)('live EA Neasden (LIVE_MAP=1)', () => {
  let grid: Float32Grid;

  beforeAll(async () => {
    const g = await fetchEaLidarGrid('ea-dtm', { bbox: NEASDEN_MAP_BBOX, resM: 8 });
    if (!g) throw new Error('live EA DTM fetch failed');
    grid = g;
  }, 120_000);

  it.each([
    [11, false, 'upright'],
    [21, false, 'upright'],
    [11, true, 'stamped'],
    [21, true, 'stamped'],
  ] as const)('×%s %s: 0 errors and 0 thin-2mm warnings', async (ex, stamped, label) => {
    const { m } = await neasdenAt(ex, { stamped, grid, water: 'bathy', overpass: true });
    const t = issueTally(m);
    // eslint-disable-next-line no-console
    console.log(
      `live Neasden ${label} ×${ex}: errors=${t.errors.length} warnings=${t.warnings.length} thin2mm=${t.thin.length}`,
      t.errors.map((e) => `${e.partId}: ${e.message}`),
      t.thin.map((e) => `${e.partId}: ${e.message}`),
    );
    expect(t.errors, t.errors.map((e) => `${e.partId}: ${e.message}`).join(' | ')).toHaveLength(0);
    expect(t.thin, t.thin.map((e) => `${e.partId}: ${e.message}`).join(' | ')).toHaveLength(0);
  }, 180_000);
});
