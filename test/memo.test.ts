import { describe, expect, it } from 'vitest';
import { cached, share } from '../src/core/memo';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { smallProject } from './small-project';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

describe('share', () => {
  it('keeps unchanged sub-objects and returns prev when nothing changed', () => {
    const prev = { a: [[1, 2], [3, 4]], b: { c: 1 }, t: new Float32Array([1, 2]) };
    expect(share(prev, structuredClone(prev))).toBe(prev);
    const next = { a: [[1, 2], [3, 5]], b: { c: 1 }, t: new Float32Array([1, 2]) };
    const s = share(prev, next);
    expect(s).toEqual(next);
    expect(s.b).toBe(prev.b);
    expect(s.t).toBe(prev.t);
    expect(s.a[0]).toBe(prev.a[0]);
    expect(s.a[1]).toBe(next.a[1]);
  });
});

describe('cached', () => {
  it('memoises per owner and key', () => {
    const owner = {};
    let n = 0;
    expect(cached(owner, 'k', () => ++n)).toBe(1);
    expect(cached(owner, 'k', () => ++n)).toBe(1);
    expect(cached(owner, 'j', () => ++n)).toBe(2);
    expect(cached({}, 'k', () => ++n)).toBe(3);
  });
});

describe('pipeline reuse', () => {
  it('reuses plates an edit did not change, and gives the same result as a cold run', () => {
    const compute = createPipeline();
    // Insert shorter than the stack so end plates stay identical when width changes.
    const seed = { plateCount: '12', baseLength: '400', insLength: '100' };
    const m1 = compute(smallProject(seed), assets);
    const p = smallProject(seed);
    p.params = { ...p.params, insWidth: String(Number(m1.v.insWidth) + 4) };
    const m2 = compute(p, assets);
    const cold = createPipeline()(p, assets);
    expect(JSON.stringify(m2.sliced)).toBe(JSON.stringify(cold.sliced));
    expect(JSON.stringify(m2.issues)).toBe(JSON.stringify(cold.issues));
    const kept = m2.sliced.parts.filter((q) => m1.sliced.parts.includes(q)).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(m2.sliced.parts.length);
  });
});
