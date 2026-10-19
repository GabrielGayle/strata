// Contrast on a depth map bends into black and white instead of clipping, so crowns stay round.
import { describe, expect, it } from 'vitest';
import { processImage, softContrast } from '../src/core/image';

describe('soft contrast for depth maps', () => {
  for (const c of [1.2, 2, 3, 5]) {
    it(`keeps every level apart at ×${c}`, () => {
      expect(softContrast(0, c)).toBeCloseTo(0, 9);
      expect(softContrast(1, c)).toBeCloseTo(1, 9);
      expect(softContrast(0.5, c)).toBeCloseTo(0.5, 9);
      let prev = -1;
      for (let i = 1; i < 1000; i++) {
        const y = softContrast(i / 1000, c);
        expect(y).toBeGreaterThan(prev);
        prev = y;
      }
    });
  }

  it('matches the plain stretch in the middle', () => {
    expect(softContrast(0.6, 1.2)).toBeCloseTo((0.6 - 0.5) * 1.2 + 0.5, 9);
  });

  it('only depth faces get it: a picture still clips', () => {
    const g = { w: 3, h: 1, data: new Float32Array([0.04, 0.5, 0.96]) };
    const opts = { contrast: 1.2, smooth: 0, invert: false, rotate: 0 };
    const hard = processImage(g, opts).data;
    const soft = processImage(g, { ...opts, soft: true }).data;
    expect(hard[0]).toBe(0);
    expect(hard[2]).toBe(1);
    expect(soft[0]).toBeGreaterThan(0);
    expect(soft[2]).toBeLessThan(1);
  });
});
