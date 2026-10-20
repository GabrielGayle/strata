import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, serialize } from '../src/core/project';
import { cleanObjects, newObject } from '../src/core/objects';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const area = (m: ReturnType<ReturnType<typeof createPipeline>>, key: string) =>
  m.sliced.parts.filter((p) => p.plateKey === key).reduce((a, p) => a + p.area, 0);

describe('placed objects', () => {
  it('notches a postcard into the top of every plate it crosses, and only those', () => {
    const compute = createPipeline();
    const plain = newProject();
    const m0 = compute(plain, assets);
    const top = Math.max(...m0.sliced.parts.map((p) => p.plane.origin[1] + p.bbox.maxY));
    const n = m0.sliced.plates[0].def.plane.normal;
    // stand the card across the stack, so its face runs along the plate normals
    const card = { ...newObject('card', [], { y: top - 25 }), ry: Math.abs(n[0]) > 0.5 ? 0 : 90 };
    expect(card.w).toBe(148);
    const m1 = compute({ ...plain, objects: [card] }, assets);
    const changed = m1.sliced.plates.filter((p) => area(m1, p.def.key) < area(m0, p.def.key) - 1);
    const pitch = m0.v.pitch;
    // a 148 mm card crosses about 148 / pitch plates
    expect(changed.length).toBeGreaterThan(148 / pitch - 3);
    expect(changed.length).toBeLessThan(148 / pitch + 3);
    // each notch is card thickness + 2 × gap wide, and no deeper than the 25 mm the card sinks in
    for (const p of changed) {
      const removed = area(m0, p.def.key) - area(m1, p.def.key);
      expect(removed).toBeLessThan(25 * 1.4 * 1.1);
    }
    // the plates still come out in one piece each
    expect(m1.sliced.parts.length).toBe(m0.sliced.parts.length);

    // switched off, it leaves the plates alone
    const m2 = compute({ ...plain, objects: [{ ...card, on: false }] }, assets);
    expect(area(m2, changed[0].def.key)).toBeCloseTo(area(m0, changed[0].def.key), 3);
  });

  it('keeps objects through save, load and variants, and repairs broken ones', () => {
    const p = { ...newProject(), objects: [newObject('box', [], { y: 100 })] };
    const back = deserialize(serialize(p));
    expect(back.objects).toEqual(p.objects);
    expect(cleanObjects([{ kind: 'nope', w: -3 }, 7])).toEqual([expect.objectContaining({ kind: 'box', w: 0.1, on: true })]);
    expect(cleanObjects([])).toBeUndefined();
    // a cutter-only box stays undrawn through a save and reload; unknown looks are dropped
    expect(cleanObjects([{ kind: 'box', look: 'hidden' }, { kind: 'box', look: 'neon' }])!.map((o) => o.look)).toEqual(['hidden', undefined]);
  });
});
