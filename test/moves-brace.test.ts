import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { sheetDxf } from '../src/core/exporters';
import type { PartMove } from '../src/core/moves';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const run = (params: Record<string, string | boolean>, moves?: Record<string, PartMove>) => {
  const p = newProject();
  p.params = { ...p.params, ...params };
  return createPipeline()({ ...p, moves }, assets);
};

describe('hand moves with bracing', () => {
  it('moves a cross spacer and checks it against the plates', () => {
    const params = { insShape: 'none', spacerMode: 'cross' };
    const m0 = run(params);
    const c0 = m0.sliced.parts.find((p) => p.family === 'C')!;
    expect(c0.pivot).toBeDefined();
    const m1 = run(params, { [c0.plateKey]: { t: [0, 0, 40], q: [0, 0, 0, 1] } });
    const c1 = m1.sliced.parts.find((p) => p.plateKey === c0.plateKey)!;
    expect(c1.home).toBeDefined();
    expect(c1.plane.origin[2]).toBeCloseTo(c0.plane.origin[2] + 40);
    expect(c1.shape).toEqual(c0.shape);
    // laser export still carries it
    expect(sheetDxf(m1, 0).length).toBeGreaterThan(0);
  });

  it('flags a template lifted into the plates', () => {
    const params = { insShape: 'none', spacerMode: 'template' };
    const t0 = run(params).sliced.parts.find((p) => p.family === 'T')!;
    const m = run(params, { [t0.plateKey]: { t: [0, -40, 0], q: [0, Math.sin(0.15), 0, Math.cos(0.15)] } });
    expect(m.issues.some((i) => i.type === 'collision' && i.message.includes(t0.id))).toBe(true);
  });

  it('drills rod holes where the rods pass through a moved plate', () => {
    const params = { insShape: 'none', anchorHoles: '0', rodsOn: true, rodCount: '2', rodSize: 'M5' };
    const m0 = run(params);
    const m1 = run(params, { P10: { t: [0, 0, 10], q: [0, 0, 0, 1] } });
    const h0 = m0.sliced.parts.find((p) => p.plateKey === 'P10')!.shape[0].holes;
    const h1 = m1.sliced.parts.find((p) => p.plateKey === 'P10')!.shape[0].holes;
    expect(h1.length).toBe(h0.length);
    const cx = (h: [number, number][]) => h.reduce((a, q) => a + q[0], 0) / h.length;
    // slid 10 mm across: the rods stay put, so the holes shift 10 mm along the plate
    expect(Math.abs(cx(h1[0]) - cx(h0[0]))).toBeCloseTo(10, 0);
  });
});
