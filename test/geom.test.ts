import { describe, expect, it } from 'vitest';
import { fitArcs, segsToPath } from '../src/core/arcs';
import { circlePath, difference, offset, rect, shapeArea } from '../src/core/geom2d';
import { marchingSquares } from '../src/core/image';
import { nest } from '../src/core/nest';

describe('2D geometry', () => {
  it('booleans and offsets', () => {
    const a = rect(0, 0, 100, 50);
    const b = rect(40, -10, 60, 30);
    const d = difference(a, b);
    expect(shapeArea(d)).toBeCloseTo(5000 - 20 * 30, 3);
    const o = offset(a, 1, 'miter');
    expect(shapeArea(o)).toBeCloseTo(102 * 52, 0);
  });
  it('fits a circle with a handful of arcs', () => {
    const segs = fitArcs(circlePath(0, 0, 25, 180), 0.01);
    expect(segs.filter((s) => s.kind === 'arc').length).toBeGreaterThan(0);
    expect(segs.length).toBeLessThan(8);
    for (const p of segsToPath(segs)) expect(Math.abs(Math.hypot(p[0], p[1]) - 25)).toBeLessThan(0.02);
  });
  it('keeps straight runs as lines', () => {
    const p = [[0, 0], [10, 0], [20, 0], [30, 0], [30, 10], [30, 20], [0, 20]] as [number, number][];
    const segs = fitArcs(p, 0.01);
    expect(segs.every((s) => s.kind === 'line')).toBe(true);
    expect(segs.length).toBe(4);
  });
  it('marching squares closes loops', () => {
    const w = 10, h = 10;
    const f = new Float32Array(w * h).fill(-1);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) f[y * w + x] = 1;
    f[5 * w + 5] = -1; // a hole pixel
    const loops = marchingSquares(f, w, h);
    expect(loops.length).toBe(2);
  });
  it('nests rectangles without overlap', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, w: 260, h: 300 + (i % 5) * 10, area: 260 * 300 }));
    const r = nest(items, 2500, 1250, 6);
    expect(r.unplaced).toEqual([]);
    for (const s of r.sheets)
      for (const a of s.placements)
        for (const b of s.placements) {
          if (a === b) continue;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
          expect(a.x + a.w).toBeLessThanOrEqual(2500);
          expect(a.y + a.h).toBeLessThanOrEqual(1250);
        }
  });
});
