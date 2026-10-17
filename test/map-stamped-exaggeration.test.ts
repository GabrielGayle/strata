import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapPresetSpec, NEASDEN_MAP_BBOX } from '../src/core/mapPresets';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { mapDepthToGray, mapTrueRangePlateMm } from '../src/core/mapPlateHeight';
import {
  flatStackHeightMm,
  flatStackIsCapped,
  formatLiveMapReadout,
  formatMapHeightCaption,
  mm0,
} from '../src/core/mapGeometryReadout';
import { applyBuiltMapAsset } from '../src/core/mapTopAsset';

/** Live EA Neasden-like DEM: valley ~35 m, peak 86 m — km-scale bbox, not a 48 m cone. */
function liveLikeNeasdenGrid(): Float32Grid {
  const b = metricBounds(NEASDEN_MAP_BBOX, 'EPSG:27700');
  const w = 64;
  const h = 64;
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

function stampedParams(plateCount: number) {
  const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
  return {
    ...preset.params,
    plateCount: String(plateCount),
    erosionAmp: '0',
    crest: '0',
    slope: '0',
    insShape: 'none',
    imgTopMode: 'carve',
  };
}

async function runStamped(ex: number, plateCount = 20) {
  const grid = liveLikeNeasdenGrid();
  const bundle = await buildMapBundle(
    defaultMapSpec({
      ...mapPresetSpec('neasden'),
      bbox: NEASDEN_MAP_BBOX,
      source: 'ea-dtm',
      water: 'raw',
      exaggeration: ex,
      layerBudget: 'jenks',
      engrave: { enabled: false, features: [] },
    }),
    {
      eaLoader: async () => grid,
      allowOverpassNetwork: false,
      stack: { plateCount, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' },
    },
  );
  const p = newProject();
  p.params = { ...p.params, ...stampedParams(plateCount) };
  p.images.top = bundle.asset;
  const gray = mapDepthToGray(bundle.depth);
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
  const layerAreas = m.sliced.plates.map((pl) => pl.parts.reduce((s, part) => s + part.area, 0));
  const stackMm = flatStackHeightMm(m.sliced.plates.length, m.v.thickness);
  const caption = formatMapHeightCaption({
    sliceMode: m.v.sliceMode,
    plates: m.sliced.plates,
    thicknessMm: m.v.thickness,
    mapFace: true,
    bboxMin: 0,
    bboxMax: 0,
    terrainTopMm: m.hf?.max,
  });
  const live = formatLiveMapReadout({
    factor: bundle.asset.map?.exaggerationFactor ?? ex,
    reliefM: bundle.depth.mapOrtho!.reliefM,
    sliceMode: m.v.sliceMode,
    plates: m.sliced.plates,
    thicknessMm: m.v.thickness,
    mapFace: true,
    terrainTopMm: m.hf?.max,
  });
  return {
    m,
    bundle,
    layerAreas,
    stackMm,
    caption,
    live,
    hfMax: m.hf?.max ?? NaN,
    wantedMm: mapTrueRangePlateMm(bundle.depth, m.v, ex),
    plateCount: m.sliced.plates.length,
    thickness: m.v.thickness,
    factor: bundle.asset.map?.exaggerationFactor,
    exaggeration: bundle.asset.map?.exaggeration,
  };
}

describe('Stamped stack exaggeration vs layer cap', () => {
  it('×11 vs ×21 on the same terrain: n×thickness is capped, layer areas still change', async () => {
    const a = await runStamped(11);
    const b = await runStamped(21);

    expect(a.m.v.sliceMode).toBe('flat');
    expect(b.m.v.sliceMode).toBe('flat');
    expect(a.plateCount).toBe(20);
    expect(b.plateCount).toBe(20);
    expect(a.factor).toBe(11);
    expect(b.factor).toBe(21);
    expect(a.exaggeration).toBe(11);
    expect(b.exaggeration).toBe(21);
    expect(a.stackMm).toBe(60);
    expect(b.stackMm).toBe(60);

    expect(b.wantedMm / a.wantedMm).toBeCloseTo(21 / 11, 5);
    expect(b.hfMax).toBeGreaterThan(a.hfMax + 10);
    expect(flatStackIsCapped(a.hfMax, a.plateCount, a.thickness)).toBe(true);
    expect(flatStackIsCapped(b.hfMax, b.plateCount, b.thickness)).toBe(true);

    const areaDiff = a.layerAreas.reduce((s, v, i) => s + Math.abs(v - (b.layerAreas[i] ?? 0)), 0);
    const topA = a.layerAreas[a.layerAreas.length - 1] ?? 0;
    const topB = b.layerAreas[b.layerAreas.length - 1] ?? 0;

    expect(a.caption).toBe(`stack height ${mm0(a.stackMm)} mm · capped at 20 layers`);
    expect(b.caption).toBe(`stack height ${mm0(b.stackMm)} mm · capped at 20 layers`);
    expect(a.live).toContain(a.caption);
    expect(b.live).toContain(b.caption);
    expect(a.live).toMatch(/^×11 · /);
    expect(b.live).toMatch(/^×21 · /);

    // Cap holds the laminated height at 20×3 mm; exaggeration still redistributes
    // which cells reach the upper layers (top slice grows as the field is clipped).
    expect(areaDiff).toBeGreaterThan(100);
    expect(topB).toBeGreaterThan(topA);
  });

  it('does not rewrite the user plate count when the terrain wants a taller stack', async () => {
    const r = await runStamped(21, 8);
    expect(r.plateCount).toBe(8);
    expect(r.stackMm).toBe(24);
    expect(r.m.v.plateCount).toBe(8);
    expect(r.hfMax).toBeGreaterThan(r.stackMm);
    expect(r.caption).toBe(`stack height ${mm0(r.stackMm)} mm · capped at 8 layers`);
  });

  it('applying a finished build keeps the user’s exaggeration and plate count', async () => {
    const built = await runStamped(21, 20);
    const p = newProject();
    p.params = { ...p.params, ...stampedParams(20) };
    p.images.top = {
      ...built.bundle.asset,
      map: { ...built.bundle.asset.map!, exaggeration: 21 },
    };
    const next = applyBuiltMapAsset(p, built.bundle.asset);
    expect(next).not.toBeNull();
    expect(next!.images.top?.map?.exaggeration).toBe(21);
    expect(next!.images.top?.map?.exaggerationFactor).toBe(21);
    expect(String(next!.params.plateCount)).toBe('20');
  });
});
