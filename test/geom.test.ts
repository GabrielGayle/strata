import { describe, expect, it } from 'vitest';
import ClipperLib from 'clipper-lib';
import { fitArcs, segsToPath } from '../src/core/arcs';
import { circlePath, difference, GeometryRangeError, offset, rect, shapeArea, union } from '../src/core/geom2d';
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
  it('joins arcs on a shared tangent along a smooth curve (biarcs)', () => {
    // an open wave, 0.4 mm steps, with a sharp step down at the end
    const p: [number, number][] = [];
    for (let x = 0; x <= 120; x += 0.4) p.push([x, 20 + 6 * Math.sin(x / 9) + 2 * Math.sin(x / 3.1)]);
    p.push([120, 0]);
    const segs = fitArcs(p, 0.05, false);
    const tan = (s: (typeof segs)[number], end: boolean): [number, number] => {
      if (s.kind === 'line') {
        const l = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
        return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
      }
      const q = end ? s.b : s.a;
      const rx = q[0] - s.c[0], ry = q[1] - s.c[1], l = Math.hypot(rx, ry);
      return s.sweep > 0 ? [-ry / l, rx / l] : [ry / l, -rx / l];
    };
    const turns = segs.slice(1).map((s, i) => {
      const a = tan(segs[i], true), b = tan(s, false);
      return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;
    });
    // only the step down at the end turns; every other join is smooth
    expect(turns.slice(0, -1).every((t) => t < 0.01)).toBe(true);
    expect(turns[turns.length - 1]).toBeGreaterThan(45);
    expect(segs.length).toBeLessThan(p.length / 5);
    // still within tolerance everywhere
    for (const q of segsToPath(segs, 0.1)) {
      let best = Infinity;
      for (let k = 0; k + 1 < p.length; k++) {
        const [a, b] = [p[k], p[k + 1]];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
      }
      expect(best).toBeLessThan(0.05);
    }
  });
  it('keeps a rectangle\'s corners sharp', () => {
    const segs = fitArcs(rect(0, 0, 40, 25)[0].outer, 0.05);
    expect(segs.length).toBe(4);
    expect(segs.every((s) => s.kind === 'line')).toBe(true);
  });
  it('marching squares closes loops', () => {
    const w = 10, h = 10;
    const f = new Float32Array(w * h).fill(-1);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) f[y * w + x] = 1;
    f[5 * w + 5] = -1; // a hole pixel
    const loops = marchingSquares(f, w, h);
    expect(loops.length).toBe(2);
  });
  it('throws GeometryRangeError for Infinity and huge coordinates without alerting', () => {
    const calls: unknown[] = [];
    const prev = globalThis.alert;
    (globalThis as typeof globalThis & { alert: (msg?: unknown) => void }).alert = (msg?: unknown) => {
      calls.push(msg);
    };
    try {
      expect(() => union([[[Infinity, 0], [1, 0], [0, 1]]])).toThrow(GeometryRangeError);
      expect(() => union([[[1e20, 0], [1e20 + 10, 0], [1e20, 10]]])).toThrow(GeometryRangeError);
      expect(() => union([[[NaN, 0], [1, 0], [0, 1]]])).toThrow(GeometryRangeError);
      expect(() => ClipperLib.Error('Coordinate outside allowed range in RangeTest().')).toThrow(GeometryRangeError);
      expect(calls).toEqual([]);
    } finally {
      if (typeof prev === 'function') globalThis.alert = prev;
      else delete (globalThis as { alert?: unknown }).alert;
    }
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
