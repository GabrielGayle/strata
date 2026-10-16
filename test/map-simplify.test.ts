import { describe, expect, it } from 'vitest';
import { simplifyMetricGrid, smallestComponentArea } from '../src/core/mapSimplify';
import type { Float32Grid } from '../src/core/mapGrid';

function grid(w: number, h: number, fill: (x: number, y: number) => number): Float32Grid {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y);
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: 0, originY: 0, pixelW: 2, pixelH: -2 },
  };
}

describe('map auto-simplify', () => {
  it('drops islands and holes below min area and reports lost count', () => {
    const g = grid(40, 40, (x, y) => {
      if (x >= 4 && x <= 5 && y >= 4 && y <= 5) return 100;
      if (x >= 20 && x <= 35 && y >= 20 && y <= 35) return 10;
      return 50;
    });
    const { grid: out, lostFeatures } = simplifyMetricGrid(g, { minIslandAreaPx: 10, minHoleAreaPx: 10, smoothRadiusPx: 0 });
    expect(lostFeatures).toBeGreaterThan(0);
    const peakMask = new Uint8Array(out.data.length);
    for (let y = 0; y < out.h; y++)
      for (let x = 0; x < out.w; x++) {
        const i = y * out.w + x;
        let nb = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= out.w || yy >= out.h) continue;
            nb += out.data[yy * out.w + xx];
            n++;
          }
        peakMask[i] = out.data[i] > nb / n + 0.25 ? 1 : 0;
      }
    expect(smallestComponentArea(peakMask, out.w, out.h, 1)).toBeGreaterThanOrEqual(10);
  });

  it('uses kerf-derived default min area when unset', () => {
    const g = grid(20, 20, () => 40);
    const r = simplifyMetricGrid(g, { kerfMm: 0.2, pixelSizeM: 2 });
    expect(r.lostFeatures).toBe(0);
  });
});
