import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPipeline, PREVIEW_SAMPLE_STEP, type Assets, type Model } from '../src/core/pipeline';
import { applyDelta, createEngineHandler, encodeDelta, packPoints, EngineWorker, geometryFromPlain, geometryToPlain, modelFromPlain, type EngineMode, type EngineReply, type EngineRequest, type PlainModel } from '../src/core/engine';
import type { Project } from '../src/core/project';
import { smallProject } from './small-project';
import { shadowFrameGray } from './engine-fixtures';

const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
// what crossing to and from a worker does to the data
const post = <T>(x: T): T => structuredClone(x);
const summary = (m: Model) =>
  JSON.stringify({ plates: m.sliced.plates.length, parts: m.sliced.parts, issues: m.issues, nested: m.nested, moulds: m.moulds, mouldNest: m.mouldNest, bom: m.bom, shadow: m.shadow?.scores ?? null });

/** Drives the worker's handler the way the page does: only changed project fields go over, and replies fold into the last one. */
function engine() {
  const handle = createEngineHandler();
  let sent: Partial<Project> | null = null;
  let plain: unknown;
  let id = 0;
  return (project: Project, assets: Assets, mode: EngineMode) => {
    const changes: Partial<Project> = {};
    for (const [k, x] of Object.entries(project)) if (!sent || (sent as Record<string, unknown>)[k] !== x) (changes as Record<string, unknown>)[k] = x;
    const first = !sent;
    sent = { ...project };
    const reply = post(handle([post({ id: ++id, mode, project: changes, dropped: [], assets: first ? { ...assets, insMesh: null, srcMesh: null } : {} } satisfies EngineRequest)])) as EngineReply;
    if ('error' in reply) throw new Error(reply.error);
    plain = applyDelta(plain, reply.model);
    return { model: modelFromPlain(plain as PlainModel), reply };
  };
}

describe('engine worker', () => {
  it('builds the same model as the pipeline on the page', () => {
    const p = smallProject();
    const { model } = engine()(p, none, 'full');
    expect(summary(model)).toBe(summary(createPipeline()(p, none)));
    expect(model.stale).toBe(false);
    expect(model.insert?.form.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(model.insert?.form.bbox).toBeInstanceOf(THREE.Box3);
    expect(model.hf?.max).toBeGreaterThan(0);
  });

  it('previews coarsely while dragging, then the full model equals the old pipeline', () => {
    const run = engine();
    const base = smallProject({ sampleStep: '1' });
    run(base, none, 'full');
    let p = base;
    for (const amp of [20, 30, 40, 50]) {
      p = { ...p, params: { ...p.params, erosionAmp: String(amp) } };
      const { model } = run(p, none, 'preview');
      expect(model.v.sampleStep).toBe(PREVIEW_SAMPLE_STEP);
      expect(model.stale).toBe(true);
    }
    const { model } = run(p, none, 'full');
    expect(model.v.sampleStep).toBe(1);
    expect(model.stale).toBe(false);
    expect(summary(model)).toBe(summary(createPipeline()(p, none)));
  });

  it('skips the shadow carve in preview and carves in full', () => {
    const frames = Array.from({ length: 3 }, (_, i) => shadowFrameGray(i));
    const p = smallProject({ sunOn: true, shadowOn: true, sunMonth: '12', sunDay: '21', sunLat: '51.5', sunLon: '0', sunUtc: '0', shadowW: '120', shadowH: '80', insertOn: false, shadowDays: '0' });
    p.shadow = { frames: frames.map((_, i) => ({ id: `f${i}`, name: `F${i}`, dataUrl: `data:x${i}`, time: 11.75 + i * 0.25, hold: 0 })) };
    const assets = { ...none, shadowFrames: frames };
    const run = engine();
    const preview = run(p, assets, 'preview').model;
    expect(preview.shadow).toBeNull();
    expect(preview.stages.find((s) => s.name === 'Shadow carve')?.stale).toBe(true);
    const full = run(p, assets, 'full').model;
    expect(full.shadow?.scores.length).toBe(3);
    expect(summary(full)).toBe(summary(createPipeline()(p, assets)));
  });

  it('keeps unchanged parts identical on the page across replies', () => {
    const run = engine();
    const p = smallProject();
    const a = run(p, none, 'full');
    // a nesting-only setting: the plates come back as the same objects, only the sheets change
    const b = run({ ...p, params: { ...p.params, partSpacing: '9' } }, none, 'full');
    expect(b.model.sliced).toBe(a.model.sliced);
    expect(b.model.insert).toBe(a.model.insert);
    expect(b.model.nested).not.toBe(a.model.nested);
    // the reply carried markers, not the plates
    expect(JSON.stringify(b.reply).length).toBeLessThan(JSON.stringify(a.reply).length / 4);
  });
});

describe('identity deltas', () => {
  it('round-trips, reuses what is the same, and keeps shared objects shared', () => {
    const shared = { x: [1, 2] };
    const prev: { a: object; list: object[]; again: object } = { a: { k: 1 }, list: [shared, { y: 2 }], again: shared };
    const nextShared = { x: [3] };
    const next = { a: prev.a, list: [nextShared, prev.list[1], { z: 1 }], again: nextShared, n: 5 };
    const pagePrev = post(prev);
    pagePrev.again = pagePrev.list[0];
    const out = applyDelta(pagePrev, post(encodeDelta(prev, next))) as typeof next;
    expect(out).toEqual(next);
    expect(out.a).toBe(pagePrev.a);
    expect(out.list[1]).toBe(pagePrev.list[1]);
    expect(out.again).toBe(out.list[0]);
  });

  it('passes a whole new value through', () => {
    const next = { a: new Float32Array([1, 2]), b: [[1, 2]] };
    expect(applyDelta(undefined, post(encodeDelta(undefined, next)))).toEqual(next);
  });
});

describe('geometry crossing', () => {
  it('rebuilds a buffer geometry from plain data', () => {
    const g = new THREE.BoxGeometry(2, 3, 4);
    const back = geometryFromPlain(post(geometryToPlain(g)));
    expect(back.getAttribute('position').count).toBe(g.getAttribute('position').count);
    expect(back.index!.count).toBe(g.index!.count);
    expect(back.groups).toEqual(g.groups);
    expect(back.boundingBox!.max.y).toBeCloseTo(1.5);
  });
});

describe('EngineWorker on the page', () => {
  it('posts each edit with only what changed, and the worker builds only the newest', () => {
    const posted: EngineRequest[] = [];
    const fake = { postMessage: (m: EngineRequest) => posted.push(post(m)), terminate() {}, onmessage: null as any, onerror: null as any };
    const results: number[] = [];
    const w = new EngineWorker(fake as unknown as Worker, (job) => results.push(job.id), () => {});
    const p = smallProject();
    w.run(p, none, 'full');
    w.run({ ...p, params: { ...p.params, erosionAmp: '10' } }, none, 'preview');
    const p3 = { ...p, params: { ...p.params, erosionAmp: '20' } };
    w.run(p3, none, 'preview');
    expect(posted.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(Object.keys(posted[0].assets).sort()).toEqual(['frontImg', 'insMesh', 'shadowFrames', 'sideImg', 'srcMesh', 'topImg']);
    expect(Object.keys(posted[2].project)).toEqual(['params']);
    expect(posted[2].assets).toEqual({});
    // all three arrived while the worker was busy: one build, of the newest
    const reply = createEngineHandler()(posted);
    expect(reply.id).toBe(3);
    expect(w.working).toBe(true);
    fake.onmessage({ data: post(reply) });
    expect(results).toEqual([3]);
    expect(w.working).toBe(false);
  });
});

describe('point lists', () => {
  it('cross as flat arrays and come back exactly, shared lists still shared', () => {
    const ring: [number, number][] = [[0.1, -0], [1e-9, 2], [NaN, 3]];
    const value = { a: { outer: ring, holes: [ring] }, b: [[1, 2, 3]], c: [[5, 6]] };
    const packed = packPoints(value);
    expect(packPoints(value)).toBe(packed);
    expect(JSON.stringify(packed)).not.toContain('[0.1');
    const back = applyDelta(undefined, post(encodeDelta(undefined, packed))) as typeof value;
    expect(back.a.outer).toEqual(ring);
    expect(Object.is(back.a.outer[0][1], -0)).toBe(true);
    expect(back.a.holes[0]).toBe(back.a.outer);
    expect(back.b).toEqual([[1, 2, 3]]);
    expect(back.c).toEqual([[5, 6]]);
  });
});
