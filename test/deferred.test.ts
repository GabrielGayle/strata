import { describe, expect, it } from 'vitest';
import { createFrontPipeline, createPipeline, deferredInput, type Assets, type DeferredInput } from '../src/core/pipeline';
import { changedFields, createDeferredHandler, DeferredWorker, type DeferredReply, type DeferredRequest } from '../src/core/deferred';
import { smallProject } from './small-project';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
// what crossing to a worker does to the data
const post = <T>(x: T): T => structuredClone(x);
const summary = (d: { issues: unknown[]; nested: unknown; moulds: unknown; mouldNest: unknown; bom: unknown }) =>
  JSON.stringify({ issues: d.issues, nested: d.nested, moulds: d.moulds, mouldNest: d.mouldNest, bom: d.bom });

describe('deferred stages in a worker', () => {
  it('give the same results from posted (cloned) inputs, and keep their cache across posts', () => {
    const project = smallProject();
    const front = createFrontPipeline();
    const f = front(project, assets);
    const input = deferredInput(f, project);
    const t0 = performance.now();
    const cloned = post(changedFields(null, input));
    console.log('posting the compact-stack inputs costs', (performance.now() - t0).toFixed(1), 'ms');

    const handle = createDeferredHandler();
    const r1 = handle({ id: 1, changes: cloned }) as Extract<DeferredReply, { result: unknown }>;
    expect('result' in r1).toBe(true);
    expect(summary(post(r1.result))).toBe(summary(createPipeline()(project, assets)));

    // the same slice again, but a fresh copy of it: checks and moulds stay cached
    const r2 = handle({ id: 2, changes: post({ sliced: input.sliced }) }) as Extract<DeferredReply, { result: unknown }>;
    expect(r2.result.stages.every((s) => s.cached)).toBe(true);

    // a check-only setting re-runs the checks but not the moulds
    const p2 = { ...project, params: { ...project.params, kerf: '0.3' } };
    const f2 = front(p2, assets);
    const in2 = deferredInput(f2, p2);
    const changes = changedFields(input, in2);
    expect(Object.keys(changes)).toEqual(['v']);
    const r3 = handle({ id: 3, changes: post(changes) }) as Extract<DeferredReply, { result: unknown }>;
    const st = Object.fromEntries(r3.result.stages.map((s) => [s.name, s.cached]));
    expect(st['Fit checks']).toBe(false);
    expect(st['Moulds']).toBe(true);
    expect(summary(r3.result)).toBe(summary(createPipeline()(p2, assets)));
  });

  it('only sends the newest input while the worker is busy', () => {
    const posted: DeferredRequest[] = [];
    const fake = { postMessage: (m: DeferredRequest) => posted.push(m), terminate() {}, onmessage: null as any, onerror: null as any };
    const results: number[] = [];
    const w = new DeferredWorker(fake as unknown as Worker, (id) => results.push(id), () => {});
    const mk = (n: number) => ({ v: { n }, sliced: {}, insert: null, pourRows: [], appearance: undefined }) as unknown as DeferredInput;
    const a = mk(1);
    w.run(a);
    w.run(mk(2));
    const c = { ...a, v: mk(3).v };
    w.run(c);
    expect(posted.map((p) => p.id)).toEqual([1]);
    fake.onmessage({ data: { id: 1, result: {} } });
    expect(results).toEqual([1]);
    // job 2 was dropped; job 3 goes out with only what changed since job 1
    expect(posted.map((p) => p.id)).toEqual([1, 3]);
    expect(Object.keys(posted[1].changes)).toEqual(['v']);
  });
});
