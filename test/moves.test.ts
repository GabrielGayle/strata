import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, deserialize, newProject, PRESETS, serialize } from '../src/core/project';
import { cleanMoves, movePlane, type PartMove } from '../src/core/moves';
import { crossingAt } from '../src/core/slicer';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const yaw = (deg: number): PartMove['q'] => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
};

describe('plate moves', () => {
  it('rotates a plane about a pivot', () => {
    const p = movePlane({ origin: [10, 0, 0], normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { t: [0, 5, 0], q: yaw(90) }, [0, 0, 0]);
    expect(p.origin[0]).toBeCloseTo(0);
    expect(p.origin[1]).toBeCloseTo(5);
    expect(p.origin[2]).toBeCloseTo(-10);
    expect(p.normal[2]).toBeCloseTo(-1);
  });

  it('carries a plate rigidly and re-cuts only where it now sits', () => {
    const compute = createPipeline();
    const base = newProject();
    const m0 = compute(base, assets);
    const key = 'P20';
    const before = m0.sliced.plates.find((p) => p.def.key === key)!;
    const moved = { ...base, moves: { [key]: { t: [0, 50, 0], q: [0, 0, 0, 1] } as PartMove } };
    const m1 = compute(moved, assets);
    const after = m1.sliced.plates.find((p) => p.def.key === key)!;
    expect(after.def.home).toBeDefined();
    expect(after.parts[0].plane.origin[1]).toBeCloseTo(before.parts[0].plane.origin[1] + 50);
    // a neighbour that didn't move keeps its identity (cheap downstream)
    expect(m1.sliced.plates.find((p) => p.def.key === 'P2')!.parts[0]).toBe(m0.sliced.plates.find((p) => p.def.key === 'P2')!.parts[0]);
    // lifted 50 mm, clear of its embed depth: flagged as no longer in the base
    expect(m1.issues.some((i) => i.plateKey === key && i.type === 'unanchored')).toBe(true);
    // put back: same result as never moved
    const m2 = compute({ ...base, moves: cleanMoves({ [key]: { t: [0, 0, 0], q: [0, 0, 0, 1] } }) }, assets);
    expect(m2.sliced.plates.find((p) => p.def.key === key)!.def.home).toBeUndefined();
  });

  it('flags a plate twisted into its neighbour', () => {
    const compute = createPipeline();
    const p = { ...newProject(), moves: { P5: { t: [0, 0, 0], q: yaw(20) } as PartMove } };
    const m = compute(p, assets);
    expect(m.issues.some((i) => i.type === 'collision' && /runs into/.test(i.message))).toBe(true);
  });

  it('keeps waffle slots on the line where moved cross plates meet', () => {
    const compute = createPipeline();
    const w = applyPreset(newProject(), PRESETS.find((x) => x.name === 'Waffle field')!);
    const m0 = compute(w, assets);
    const x0 = m0.sliced.plates.find((p) => p.def.key === 'X1')!;
    const m1 = compute({ ...w, moves: { X1: { t: [6, 0, 0], q: yaw(2) } } }, assets);
    const x1 = m1.sliced.plates.find((p) => p.def.key === 'X1')!;
    const p3 = m1.sliced.plates.find((p) => p.def.key === 'P3')!;
    const c = crossingAt(p3.def.plane, x1.def.plane, m1.v.baseOn ? m1.v.baseHeight : 0)!;
    expect(c).not.toBeNull();
    expect(x1.parts.map((q) => q.id)).toEqual(x0.parts.map((q) => q.id));
    // no moved-plate collisions: slots were re-cut where the plates now cross
    expect(m1.issues.filter((i) => /runs into/.test(i.message))).toEqual([]);
  });

  it('round-trips through the project file and drops junk', () => {
    const p = { ...newProject(), moves: { P1: { t: [1, 2, 3], q: yaw(10) } as PartMove } };
    const back = deserialize(serialize(p));
    expect(back.moves?.P1.t).toEqual([1, 2, 3]);
    expect(cleanMoves({ P1: { t: [1, 'x', 3], q: [0, 0, 0, 1] }, P2: { t: [0, 0, 0], q: [0, 0, 0, 1] } })).toBeUndefined();
  });
});
