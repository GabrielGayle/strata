import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { baseVolumeBetween, basePlan, baseGeometry, planClearance } from '../src/core/base';
import { evaluateParams } from '../src/core/params';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

function run(params: Record<string, string | boolean>) {
  const p = newProject();
  p.params = { ...p.params, ...params };
  return createPipeline()(p, assets);
}

describe('chamfered base', () => {
  it('cuts corners and the top edge, and the volume follows', () => {
    const v = evaluateParams({ ...newProject().params, baseCornerChamfer: '30', baseEdgeChamfer: '10' }).values;
    const box = v.baseLength * v.baseWidth * v.baseHeight;
    const vol = baseVolumeBetween(v, 0, v.baseHeight);
    expect(vol).toBeLessThan(box);
    // 4 corner prisms + top bevel strip, roughly
    const corners = 4 * (30 * 30 / 2) * v.baseHeight;
    expect(box - vol).toBeGreaterThan(corners);
    expect(basePlan(v)).toHaveLength(8);
    expect(planClearance(v, v.baseLength / 2 - 5, v.baseWidth / 2 - 5)).toBeLessThan(0);
    expect(planClearance(v, 0, 0)).toBeCloseTo(v.baseWidth / 2, 5);
    const g = baseGeometry(v);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(v.baseHeight, 5);
  });

  it('keeps radial plates inside chamfered corners', () => {
    const m = run({ sliceMode: 'radial', baseCornerChamfer: '80', insShape: 'none' });
    expect(m.issues.filter((i) => i.message.includes('chamfered base'))).toEqual([]);
  });
});

describe('radial support ring', () => {
  it('gives every radial plate a tenon through a matching ring slot', () => {
    const m = run({ sliceMode: 'radial', supportMode: 'radial', insShape: 'none' });
    const ring = m.sliced.parts.filter((p) => p.family === 'S');
    expect(ring).toHaveLength(1);
    const plates = m.sliced.plates.filter((p) => p.parts.length);
    expect(plates.length).toBe(m.v.radialCount);
    for (const p of plates) expect(p.tenons).toBeGreaterThan(0);
    // one mortise per tenon, plus the centre hole of the ring
    const slots = plates.reduce((a, p) => a + p.tenons, 0);
    expect(ring[0].shape[0].holes.length).toBe(slots + 1);
    // tenons reach the bottom of the ring
    const sup = m.sliced.support!;
    for (const p of plates) expect(Math.min(...p.parts.map((q) => q.bbox.minY))).toBeCloseTo(sup.tenonBottom, 3);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.nested.unplaced).toEqual([]);
  });

  it('works under a parallel stack too, and trims tabs when the ring sits higher', () => {
    const m = run({ supportMode: 'radial', supportDepth: '20', embedDepth: '40', insShape: 'none' });
    const sup = m.sliced.support!;
    expect(sup.depth).toBe(20);
    const crossing = m.sliced.plates.filter((p) => p.tenons > 0);
    expect(crossing.length).toBeGreaterThan(5);
    const ring = m.sliced.parts.filter((p) => p.family === 'S');
    expect(ring.length).toBeGreaterThanOrEqual(1);
  });

  it('flags a ring that pokes out of the base', () => {
    const m = run({ sliceMode: 'radial', supportMode: 'radial', supportDepth: '200', insShape: 'none' });
    expect(m.issues.some((i) => i.severity === 'error' && i.message.includes('bottom of the base'))).toBe(true);
  });
});
