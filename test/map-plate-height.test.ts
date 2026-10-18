import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import {
  buildMapHeightField,
  MAP_HEIGHT_FLOOR_MM,
  mapDepthToGray,
  mapReliefToPlateRangeMm,
  mapScaleMmPerM,
  mapTrueRangePlateMm,
} from '../src/core/mapPlateHeight';
import { plateOutlineYRangeMm, plateTopHeightRangeMm } from '../src/core/slicer';
import { depthToGray } from '../src/core/depth';
import { evaluateParams } from '../src/core/params';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

function gridMinMax(grid: { data: Float32Array }): { zMin: number; zMax: number } {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of grid.data) {
    if (!Number.isFinite(z)) continue;
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }
  return { zMin, zMax };
}

describe('map elevation → plate heights (invariant)', () => {
  it('uses true min/max, not p98, and linear settings', () => {
    const grid = syntheticConeGrid(32, 20, 18);
    const { zMin, zMax } = gridMinMax(grid);
    const { depth, meta } = mapGridToDepth(grid, { exaggeration: 4 });
    expect(depth.mapOrtho?.zMinM).toBeCloseTo(zMin, 5);
    expect(depth.mapOrtho?.zMaxM).toBeCloseTo(zMax, 5);
    expect(depth.mapOrtho?.reliefM).toBeCloseTo(zMax - zMin, 5);
    expect(meta.zTopM).toBeCloseTo(zMax, 5);
    expect(zMax).toBeLessThan(18);
    expect(zMax).toBeGreaterThan(16);
    expect(depth.settings.spacing).toBe('linear');
    expect(depth.settings.flatten).toBe(0);
    expect(depth.settings.matte).toBe(false);
  });

  it('plate height range matches relief_m × exaggeration × plan scale (mm)', () => {
    const coneH = 18;
    const ex = 5;
    const grid = syntheticConeGrid(48, 24, coneH);
    const { zMin, zMax } = gridMinMax(grid);
    const { depth } = mapGridToDepth(grid, { exaggeration: ex, bbox: NEASDEN_FAST_BBOX });
    const p = newProject();
    p.params = {
      ...p.params,
      baseLength: '600',
      baseWidth: '600',
      plateCount: '24',
      thickness: '3',
      stackHeight: '200',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
      imgContrast: '5',
      imgSmooth: '8',
      imgMix: '0.4',
      imgRange: '20',
      topFloor: 'flat',
      topDepth: '18',
      imgTopMode: 'carve',
    };
    p.images.top = {
      name: 'Map',
      dataUrl: 'data:image/png;base64,xx',
      map: defaultMapSpec({ bbox: NEASDEN_FAST_BBOX, title: 'Cone' }),
      depth,
    };
    const gray = mapDepthToGray(depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.insert).toBeNull();
    expect(m.sliced.plates.every((plate) => plate.cavity.length === 0)).toBe(true);
    const expected = mapTrueRangePlateMm(depth, m.v, ex);
    const scale = mapScaleMmPerM(depth.mapOrtho!.widthM, 600);
    expect(expected).toBeCloseTo(mapReliefToPlateRangeMm(zMax - zMin, ex, scale), 5);
    const range = plateTopHeightRangeMm(m.sliced.plates);
    const outline = plateOutlineYRangeMm(m.sliced.plates);
    expect(outline).toBeTruthy();
    expect(range).toBeCloseTo(outline!.hi - outline!.lo, 5);
    expect(range).toBeGreaterThan(expected * 0.75);
    expect(range).toBeLessThan(expected * 1.25);
    expect(range).toBeGreaterThan(80);
  });

  it('flatten, contrast and mix do not change map plate heights', () => {
    const grid = syntheticConeGrid(32, 20, 12);
    const { depth } = mapGridToDepth(grid, { exaggeration: 3 });
    depth.settings = {
      ...depth.settings,
      flatten: 1,
      curve: 2.5,
      spacing: 'perspective',
      flatLevelMode: 'auto',
      flatLevel: 0.5,
      flatLevelOverride: true,
      stepLimit: 0.08,
      edgeEase: 1,
    };
    const v = evaluateParams({
      baseLength: '400',
      baseWidth: '400',
      stackHeight: '100',
      erosionAmp: '80',
      imgMix: '0.2',
      imgRange: '10',
    }).values;
    const hf = buildMapHeightField(v, depth);
    expect(hf.max - hf.min).toBeGreaterThan(50);
    const gray = mapDepthToGray(depth);
    const photo = depthToGray(depth);
    let maxDiff = 0;
    const n = Math.min(gray.data.length, photo.data.length);
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(gray.data[i] - photo.data[i]));
    expect(maxDiff).toBeGreaterThan(0.05);
  });

  it('caption span at ×21 matches the readout with and without a sunken frame', () => {
    const grid = syntheticConeGrid(48, 24, 18);

    const run = (ex: number, frame: boolean) => {
      const { depth } = mapGridToDepth(grid, { exaggeration: ex, bbox: NEASDEN_FAST_BBOX });
      const p = newProject();
      p.params = {
        ...p.params,
        baseLength: '600',
        baseWidth: '600',
        plateCount: '16',
        thickness: '3',
        stackHeight: '200',
        erosionAmp: '0',
        crest: '0',
        slope: '0',
        insShape: 'none',
        imgTopMode: 'carve',
      };
      p.images.top = {
        name: 'Map',
        dataUrl: 'data:image/png;base64,xx',
        map: defaultMapSpec({
          bbox: NEASDEN_FAST_BBOX,
          title: 'Cone',
          exaggeration: ex,
          ...(frame ? { sunkenFrame: { enabled: true, wallMm: 12 } } : {}),
        }),
        depth,
      };
      const gray = mapDepthToGray(depth);
      const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
      const expected = mapTrueRangePlateMm(depth, m.v, ex);
      const outline = plateOutlineYRangeMm(m.sliced.plates);
      return { expected, outline, hf: m.hf };
    };

    // Warm the decode cache at ×11 so a stale key (payload without minM/maxM) would
    // reuse those metres under a ×21 window — the live 136–282 mm / 278 mm stack bug.
    run(11, false);

    for (const frame of [false, true]) {
      const r = run(21, frame);
      expect(r.outline, `frame=${frame}`).toBeTruthy();
      expect(r.outline!.lo, `frame=${frame} valley floor`).toBeLessThan(15);
      expect(r.outline!.lo, `frame=${frame}`).toBeGreaterThan(0.5);
      const span = r.outline!.hi - r.outline!.lo;
      expect(span, `frame=${frame} caption span`).toBeGreaterThan(r.expected * 0.75);
      expect(span, `frame=${frame} caption span`).toBeLessThan(r.expected * 1.25);
      expect(r.hf!.min, `frame=${frame}`).toBeLessThan(15);
    }

    const off = run(21, false);
    const on = run(21, true);
    expect(on.outline!.lo).toBeCloseTo(off.outline!.lo, 0);
    expect(on.outline!.hi - on.outline!.lo).toBeCloseTo(off.outline!.hi - off.outline!.lo, 0);
  });

  it('stays finite when a 1e38 elevation is injected', () => {
    const grid = syntheticConeGrid(32, 20, 18);
    grid.data[4] = 1e38;
    grid.data[5] = Number.POSITIVE_INFINITY;
    const { depth } = mapGridToDepth(grid, { exaggeration: 4 });
    expect(Number.isFinite(depth.mapOrtho!.zMinM)).toBe(true);
    expect(Number.isFinite(depth.mapOrtho!.zMaxM)).toBe(true);
    expect(depth.mapOrtho!.zMaxM).toBeLessThan(100);
    depth.settings = { ...depth.settings, near: 1e38, far: 2e38 };
    const v = evaluateParams({
      baseLength: '400',
      baseWidth: '400',
      stackHeight: '100',
    }).values;
    const hf = buildMapHeightField(v, depth);
    expect(Number.isFinite(hf.min)).toBe(true);
    expect(Number.isFinite(hf.max)).toBe(true);
    expect(Math.abs(hf.max)).toBeLessThan(1e7);
    expect(Math.abs(hf.min)).toBeLessThan(1e7);
    for (let i = 0; i <= 8; i++) {
      const h = hf.at((i / 8 - 0.5) * 400, 0);
      expect(Number.isFinite(h)).toBe(true);
      expect(Math.abs(h)).toBeLessThan(1e7);
    }
  });

  it('keeps the default insert when the top face is not a map', () => {
    const p = newProject();
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
    expect(m.insert).not.toBeNull();
  });

  it('scales to plate height instead of clipping the peaks', () => {
    const grid = syntheticConeGrid(48, 24, 18);
    const { depth } = mapGridToDepth(grid, { exaggeration: 8, bbox: NEASDEN_FAST_BBOX });
    const v = evaluateParams({
      baseLength: '400',
      baseWidth: '400',
      stackHeight: '40',
      sliceMode: 'parallel',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
    }).values;
    const hf = buildMapHeightField(v, depth, { capMm: 40 });
    expect(hf.heightCapScale).toBeDefined();
    expect(hf.heightCapScale!).toBeLessThan(1);
    expect(hf.max).toBeLessThanOrEqual(40 + 1e-6);
    expect(hf.max).toBeGreaterThan(MAP_HEIGHT_FLOOR_MM + 10);
    const p = newProject();
    p.userParamOverrides = { stackHeight: true };
    p.params = {
      ...p.params,
      baseLength: '400',
      baseWidth: '400',
      plateCount: '12',
      stackHeight: '40',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
      insShape: 'none',
    };
    p.images.top = {
      name: 'Map',
      dataUrl: 'data:image/png;base64,xx',
      map: defaultMapSpec({ bbox: NEASDEN_FAST_BBOX, title: 'Cap' }),
      depth,
    };
    const gray = mapDepthToGray(depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.sliced.warnings.some((w) => /scaled to fit/i.test(w) && /not clipped/i.test(w))).toBe(true);
    const outline = plateOutlineYRangeMm(m.sliced.plates);
    expect(outline).toBeTruthy();
    expect(outline!.hi).toBeLessThanOrEqual(40 + 0.5);
    expect(outline!.hi).toBeGreaterThan(outline!.lo + 8);
  });
});
