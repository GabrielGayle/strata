import { describe, expect, it } from 'vitest';
import { chooseSnap, closestOnSegment, lineAngle, measureLines, measurePointFace, measurePointLine, measurePoints, pointPlane, segmentSegment, slabGap, type Seg } from '../src/core/measure';
import type { V3 } from '../src/core/section';

// a straight-down orthographic "camera": screen x = world x, screen y = world z, 1 px per mm
const topDown = (p: V3): [number, number] => [p[0], p[2]];

describe('measure: closest points', () => {
  it('finds the nearest point on a segment, clamped to its ends', () => {
    const r = closestOnSegment([5, 3, 0], [0, 0, 0], [10, 0, 0]);
    expect(r.point).toEqual([5, 0, 0]);
    expect(r.t).toBeCloseTo(0.5);
    expect(r.dist).toBeCloseTo(3);
    const end = closestOnSegment([-4, 3, 0], [0, 0, 0], [10, 0, 0]);
    expect(end.point).toEqual([0, 0, 0]);
    expect(end.dist).toBeCloseTo(5);
    expect(closestOnSegment([1, 1, 1], [2, 2, 2], [2, 2, 2]).dist).toBeCloseTo(Math.sqrt(3));
  });

  it('finds the shortest distance between skew segments', () => {
    // along x at z=0, and along y at x=4, z=7
    const r = segmentSegment([0, 0, 0], [10, 0, 0], [4, -5, 7], [4, 5, 7]);
    expect(r.dist).toBeCloseTo(7);
    expect(r.p[0]).toBeCloseTo(4);
    expect(r.q[1]).toBeCloseTo(0);
  });

  it('handles parallel, overlapping and end-to-end segments', () => {
    const par = segmentSegment([0, 0, 0], [10, 0, 0], [5, 2, 0], [15, 2, 0]);
    expect(par.dist).toBeCloseTo(2);
    const apart = segmentSegment([0, 0, 0], [10, 0, 0], [13, 4, 0], [20, 4, 0]);
    expect(apart.dist).toBeCloseTo(5); // 3-4-5 from (10,0) to (13,4)
    const cross = segmentSegment([-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]);
    expect(cross.dist).toBeCloseTo(0);
    const pointish = segmentSegment([0, 0, 0], [0, 0, 0], [3, -1, 0], [3, 1, 0]);
    expect(pointish.dist).toBeCloseTo(3);
  });

  it('drops a perpendicular onto a plane with a signed distance', () => {
    const r = pointPlane([3, 9, 4], [0, 5, 0], [0, 2, 0]);
    expect(r.signed).toBeCloseTo(4);
    expect(r.foot).toEqual([3, 5, 4]);
    expect(pointPlane([0, 1, 0], [0, 5, 0], [0, 1, 0]).signed).toBeCloseTo(-4);
  });

  it('measures the angle between lines regardless of direction', () => {
    expect(lineAngle([1, 0, 0], [0, 1, 0])).toBeCloseTo(90);
    expect(lineAngle([1, 0, 0], [-1, 0, 0])).toBeCloseTo(0);
    expect(lineAngle([1, 0, 0], [1, 1, 0])).toBeCloseTo(45);
    expect(lineAngle([1, 0, 0], [-1, 1, 0])).toBeCloseTo(45);
  });
});

describe('measure: results', () => {
  it('point to point carries the X / Y / Z deltas', () => {
    const m = measurePoints([0, 0, 0], [30, 40, 120]);
    expect(m.dist).toBeCloseTo(130);
    expect(m.delta).toEqual([30, 40, 120]);
  });

  it('line to line gives distance and angle', () => {
    const m = measureLines([[0, 0, 0], [100, 0, 0]], [[0, 10, 0], [100, 10, 100]]);
    expect(m.dist).toBeCloseTo(10);
    expect(m.angle).toBeCloseTo(45);
    expect(m.guides).toHaveLength(2);
  });

  it('point to line and point to face', () => {
    expect(measurePointLine([5, 5, 0], [[0, 0, 0], [10, 0, 0]]).dist).toBeCloseTo(5);
    // two parallel plates 6 mm thick at x=0 and x=40: the gap between facing surfaces
    const gap = measurePointFace([3, 50, 20], [37, 0, 0], [-1, 0, 0]);
    expect(gap.dist).toBeCloseTo(34);
    expect(gap.b).toEqual([37, 50, 20]);
  });
});

describe('measure: snapping', () => {
  const square: Seg[] = [
    [[0, 0, 0], [100, 0, 0]],
    [[100, 0, 0], [100, 0, 100]],
    [[100, 0, 100], [0, 0, 100]],
    [[0, 0, 100], [0, 0, 0]],
  ];
  const at = (x: number, z: number, snap = true) => chooseSnap({ cursor: [x, z], hit: [x, 0, z], normal: [0, 1, 0], edges: square, project: topDown }, { snap });

  it('prefers a vertex near the cursor', () => {
    const s = at(96, 4);
    expect(s.kind).toBe('vertex');
    expect(s.point).toEqual([100, 0, 0]);
  });

  it('then an edge midpoint, then the nearest point on an edge', () => {
    const m = at(52, 5);
    expect(m.kind).toBe('midpoint');
    expect(m.point).toEqual([50, 0, 0]);
    const e = at(30, 6);
    expect(e.kind).toBe('edge');
    expect(e.point[0]).toBeCloseTo(30);
    expect(e.point[2]).toBeCloseTo(0);
    expect(e.edge).toBe(square[0]);
  });

  it('falls back to the face, still naming the nearest edge within reach', () => {
    const f = at(25, 30);
    expect(f.kind).toBe('face');
    expect(f.point).toEqual([25, 0, 30]);
    expect(f.edge).toBe(square[3]); // x=0 is 25 px away
    expect(at(50, 50).edge).toBeUndefined();
  });

  it('turns snapping off but keeps the nearest edge', () => {
    const s = at(97, 3, false);
    expect(s.kind).toBe('free');
    expect(s.point).toEqual([97, 0, 3]);
    expect(s.edge).toBeDefined();
  });
});

describe('measure: slab gap (plate clearance while moving)', () => {
  const box = (x0: number, x1: number): V3[] => [
    [x0, 0, 0],
    [x1, 0, 0],
    [x0, 10, 5],
    [x1, 10, 5],
  ];
  it('measures face to face on either side and goes negative when overlapping', () => {
    // neighbour plate 6 thick centred at x=0 occupies -3..3
    expect(slabGap(box(10, 16), [0, 0, 0], [1, 0, 0], 6)).toBeCloseTo(7);
    expect(slabGap(box(-20, -14), [0, 0, 0], [1, 0, 0], 6)).toBeCloseTo(11);
    expect(slabGap(box(1, 7), [0, 0, 0], [1, 0, 0], 6)).toBeCloseTo(-2);
  });
});
