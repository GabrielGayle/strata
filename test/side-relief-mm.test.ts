// Image as height with the relief set in millimetres: background at Background height, brightest Relief depth above.
import { describe, expect, it } from 'vitest';
import { buildHeightField, PLATE_FLOOR_MM } from '../src/core/heightfield';
import { defaultRaw, evaluateParams, PARAM_MAP } from '../src/core/params';
import type { Gray } from '../src/core/image';

function disc(): Gray {
  const w = 128, h = 64;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot((x - w / 2) / 40, (y - h / 2) / 24);
      data[y * w + x] = r < 1 ? 0.15 + 0.85 * (1 - r) : 0;
    }
  return { w, h, data };
}

const evaluate = (over: Record<string, string>) =>
  evaluateParams({ ...defaultRaw(), stackSource: 'strata', strataOn: false, imgSideMode: 'heightmap', imgSideFit: 'off', imgMix: '0.25', imgRange: '300', stackHeight: '10', ...over });

describe('side relief in millimetres', () => {
  it('puts the background at Background height and the brightest point Relief depth above it', () => {
    const v = evaluate({ imgReliefSet: 'mm', imgReliefBase: '8', imgReliefDepth: '15' }).values;
    const hf = buildHeightField(v, disc());
    const corner = hf.at(v.baseLength * 0.45, v.baseWidth * 0.45);
    expect(corner).toBeCloseTo(8, 1);
    expect(hf.at(0, 0)).toBeGreaterThan(8 + 15 * 0.9);
    expect(hf.at(0, 0)).toBeLessThanOrEqual(8 + 15 + 1e-6);
    expect(hf.floorClip).toBeUndefined();
  });

  it('never goes below the floor, even when asked to', () => {
    const v = evaluate({ imgReliefSet: 'mm', imgReliefBase: '0', imgReliefDepth: '15' }).values;
    expect(buildHeightField(v, disc()).at(v.baseLength * 0.45, 0)).toBeGreaterThanOrEqual(PLATE_FLOOR_MM);
  });

  it('starts from the heights the mix settings gave, where they cleared the floor', () => {
    const v = evaluate({ stackHeight: '40', imgReliefSet: 'mm' }).values;
    // 40 − 300 × 0.25 / 2 = 2.5 → the floor; depth 300 × 0.25 = 75
    expect(v.imgReliefBase).toBeCloseTo(PLATE_FLOOR_MM, 6);
    expect(v.imgReliefDepth).toBeCloseTo(75, 6);
    const w = evaluate({ stackHeight: '60', imgReliefSet: 'mm' }).values;
    const mixed = buildHeightField(evaluate({ stackHeight: '60' }).values, disc());
    const mm = buildHeightField(w, disc());
    expect(mm.at(0, 0)).toBeCloseTo(mixed.at(0, 0), 3);
    expect(mm.at(30, 10)).toBeCloseTo(mixed.at(30, 10), 3);
  });

  it('hides mix and range while millimetres are on', () => {
    const r = evaluate({ imgReliefSet: 'mm' });
    const show = (id: string) => PARAM_MAP[id].show?.(r.values) ?? true;
    expect(show('imgReliefBase')).toBe(true);
    expect(show('imgMix')).toBe(false);
    expect(show('imgRange')).toBe(false);
  });
});
