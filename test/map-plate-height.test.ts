import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import {
  buildMapHeightField,
  mapDepthToGray,
  mapReliefToPlateRangeMm,
  mapScaleMmPerM,
  mapTrueRangePlateMm,
} from '../src/core/mapPlateHeight';
import { plateTopHeightRangeMm } from '../src/core/slicer';
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

  it('keeps the default insert when the top face is not a map', () => {
    const p = newProject();
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
    expect(m.insert).not.toBeNull();
  });
});
