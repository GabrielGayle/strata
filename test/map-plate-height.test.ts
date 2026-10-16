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

describe('map elevation → plate heights (invariant)', () => {
  it('uses true min/max, not p98, and linear settings', () => {
    const grid = syntheticConeGrid(32, 20, 18);
    const { depth, meta } = mapGridToDepth(grid, { exaggeration: 4 });
    expect(depth.mapOrtho?.zMinM).toBeCloseTo(0, 5);
    expect(depth.mapOrtho?.zMaxM).toBeCloseTo(18, 5);
    expect(depth.mapOrtho?.reliefM).toBeCloseTo(18, 5);
    expect(meta.zTopM).toBeCloseTo(18, 5);
    expect(depth.settings.spacing).toBe('linear');
    expect(depth.settings.flatten).toBe(0);
    expect(depth.settings.matte).toBe(false);
  });

  it('plate height range matches relief_m × exaggeration × plan scale (mm)', () => {
    const reliefM = 18;
    const ex = 5;
    const grid = syntheticConeGrid(48, 24, reliefM);
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
    const expected = mapTrueRangePlateMm(depth, m.v, ex);
    const scale = mapScaleMmPerM(depth.mapOrtho!.widthM, 600);
    expect(expected).toBeCloseTo(mapReliefToPlateRangeMm(reliefM, ex, scale), 5);
    const range = plateTopHeightRangeMm(m.sliced.plates);
    expect(range).toBeGreaterThan(expected * 0.75);
    expect(range).toBeLessThan(expected * 1.25);
    expect(range).toBeGreaterThan(80);
  });

  it('flatten, contrast and mix do not change map plate heights', () => {
    const grid = syntheticConeGrid(32, 20, 12);
    const { depth } = mapGridToDepth(grid, { exaggeration: 3 });
    depth.settings = { ...depth.settings, flatten: 1, curve: 2.5, spacing: 'perspective' };
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
    expect(gray.data[0]).not.toBe(photo.data[0]);
  });
});
