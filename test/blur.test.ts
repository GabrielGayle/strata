import { describe, expect, it } from 'vitest';
import { blurImage, blurSpec, DEFAULT_BLUR, type BlurSpec } from '../src/core/blur';
import { boxBlur, processImage, type Gray } from '../src/core/image';
import { evaluateParams, PARAMS } from '../src/core/params';

const N = 41;
/** A single white dot on black, off centre. */
function dot(x = 30, y = 20): Gray {
  const data = new Float32Array(N * N);
  data[y * N + x] = 1;
  return { w: N, h: N, data };
}
const spec = (s: Partial<BlurSpec>): BlurSpec => ({ ...DEFAULT_BLUR, ...s });
const at = (g: Gray, x: number, y: number) => g.data[y * g.w + x];
const total = (g: Gray) => g.data.reduce((a, b) => a + b, 0);

describe('image blur types', () => {
  it('default params keep the old soft blur exactly', () => {
    const v = evaluateParams({}).values;
    expect(v.imgBlurType).toBe('box');
    const g = dot();
    const opts = { contrast: 1, smooth: 2, invert: false, rotate: 0 };
    const before = processImage(g, opts);
    const after = processImage(g, { ...opts, blur: blurSpec({ ...v, imgSmooth: 2 }) });
    expect(Array.from(after.data)).toEqual(Array.from(before.data));
    expect(Array.from(blurImage(g, spec({ size: 3 })).data)).toEqual(Array.from(boxBlur(g, 3).data));
  });

  it('directional blur streaks along its angle only', () => {
    const h = blurImage(dot(20, 20), spec({ type: 'motion', length: 10, angle: 0 }));
    expect(at(h, 24, 20)).toBeGreaterThan(0);
    expect(at(h, 20, 24)).toBe(0);
    const v = blurImage(dot(20, 20), spec({ type: 'motion', length: 10, angle: 90 }));
    expect(at(v, 20, 24)).toBeGreaterThan(0);
    expect(at(v, 24, 20)).toBe(0);
  });

  it('radial blur sweeps around the centre, zoom streaks toward it', () => {
    // dot right of centre (20,20): radial spreads it up/down, zoom streaks it outward along the ray
    const r = blurImage(dot(35, 20), spec({ type: 'radial', spin: 30 }));
    expect(at(r, 35, 17)).toBeGreaterThan(0);
    expect(at(r, 31, 20)).toBe(0);
    const z = blurImage(dot(35, 20), spec({ type: 'zoom', zoom: 40 }));
    expect(at(z, 38, 20)).toBeGreaterThan(0);
    expect(at(z, 35, 17)).toBe(0);
  });

  it('radial blur leaves the centre itself sharp', () => {
    const r = blurImage(dot(20, 20), spec({ type: 'radial', spin: 60 }));
    expect(at(r, 20, 20)).toBeCloseTo(1, 5);
  });

  it('lens keeps the light it spreads', () => {
    const l = blurImage(dot(20, 20), spec({ type: 'lens', size: 4 }));
    expect(total(l)).toBeCloseTo(1, 4);
    expect(at(l, 20, 20)).toBeLessThan(0.1);
  });

  it('surface blur smooths grain but keeps a hard step', () => {
    const data = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) data[y * N + x] = (x < 20 ? 0.1 : 0.9) + ((x + y) % 2 ? 0.02 : -0.02);
    const g = { w: N, h: N, data };
    const s = blurImage(g, spec({ type: 'surface', size: 3, edge: 0.15 }));
    expect(at(s, 19, 10)).toBeLessThan(0.15);
    expect(at(s, 20, 10)).toBeGreaterThan(0.85);
    expect(Math.abs(at(s, 5, 10) - at(s, 6, 10))).toBeLessThan(0.01);
    const soft = boxBlur(g, 3);
    expect(at(soft, 19, 10)).toBeGreaterThan(0.3);
  });

  it('tilt-shift stays sharp in the band and blurs away from it', () => {
    const near = blurImage(dot(20, 20), spec({ type: 'tilt', size: 4, focus: 0.2 }));
    expect(at(near, 20, 20)).toBe(1);
    const far = blurImage(dot(20, 2), spec({ type: 'tilt', size: 4, focus: 0.2 }));
    expect(at(far, 20, 2)).toBeLessThan(0.5);
  });

  it('blur settings only show for the types that use them', () => {
    const shown = (id: string, type: string) => PARAMS.find((p) => p.id === id)!.show!({ imgBlurType: type });
    expect(shown('imgSmooth', 'box')).toBe(true);
    expect(shown('imgSmooth', 'radial')).toBe(false);
    expect(shown('imgBlurAngle', 'motion')).toBe(true);
    expect(shown('imgBlurAngle', 'zoom')).toBe(false);
    expect(shown('imgBlurX', 'zoom')).toBe(true);
    expect(shown('imgBlurSpin', 'box')).toBe(false);
  });
});
