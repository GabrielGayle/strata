import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import type { Gray } from '../src/core/image';

const blank = (w: number, h: number): Gray => ({ w, h, data: new Float32Array(w * h).fill(0.5) });

function run(params: Record<string, string>, imgs: { frontImg?: Gray; sideImg?: Gray }) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', ...params };
  return createPipeline()(p, { sideImg: imgs.sideImg ?? null, frontImg: imgs.frontImg ?? null, topImg: null, insMesh: null, srcMesh: null });
}

describe('fit face to image', () => {
  it('front: keeps plate height and sets the base width from the image', () => {
    const m = run({ imgFrontMode: 'layers', imgFrontFit: 'width' }, { frontImg: blank(300, 100) });
    const w = m.v.plateWidth - 2 * m.v.frontMargin;
    const h = m.v.stackHeight - 2 * m.v.frontMargin;
    expect(m.v.stackHeight).toBe(220);
    expect(w / h).toBeCloseTo(3, 3);
    expect(m.ev.overrides.baseWidth).toBeTruthy();
  });

  it('front: keeps width and sets the plate height from the image', () => {
    const m = run({ imgFrontMode: 'layers', imgFrontFit: 'height' }, { frontImg: blank(100, 200) });
    const w = m.v.plateWidth - 2 * m.v.frontMargin;
    expect(w / (m.v.stackHeight - 2 * m.v.frontMargin)).toBeCloseTo(0.5, 3);
    expect(m.v.baseWidth).toBe(300);
  });

  it('side: keeps width, sets length, and the plate count follows at a fixed gap', () => {
    const before = run({ imgSideMode: 'heightmap', spacingMode: 'gap', plateGap: '10' }, { sideImg: blank(400, 100) });
    const m = run({ imgSideMode: 'heightmap', imgSideFit: 'length', spacingMode: 'gap', plateGap: '10' }, { sideImg: blank(400, 100) });
    expect(m.v.baseLength / m.v.baseWidth).toBeCloseTo(4, 3);
    expect(m.v.baseWidth).toBe(before.v.baseWidth);
    expect(m.v.pitch).toBe(before.v.pitch);
    expect(m.v.plateCount).toBeGreaterThan(before.v.plateCount);
  });

  it('side: Image rotate turns the image proportions', () => {
    const m = run({ imgSideMode: 'heightmap', imgSideFit: 'length', imgRotate: '90' }, { sideImg: blank(100, 200) });
    expect(m.v.baseLength / m.v.baseWidth).toBeCloseTo(2, 3);
  });

  it('side silhouette sets the height range from the plate width', () => {
    const m = run({ imgSideMode: 'silhouette', imgSideFit: 'length' }, { sideImg: blank(300, 150) });
    expect(m.v.imgRange).toBeCloseTo(m.v.baseWidth / 2, 3);
    expect(m.ev.overrides.baseLength).toBeUndefined();
  });

  it('Image switch off turns every fit off', () => {
    const m = run({ imgSideMode: 'heightmap', imgSideFit: 'length', imgFrontMode: 'layers', imgFrontFit: 'width', imageOn: 'false' }, { sideImg: blank(400, 100), frontImg: blank(300, 100) });
    expect(m.ev.overrides).toEqual({});
  });
});
