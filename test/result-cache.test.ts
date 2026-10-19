import { afterEach, describe, expect, it } from 'vitest';
import { createPipeline, type Assets, type Model } from '../src/core/pipeline';
import { applyDelta, createEngineHandler, modelFromPlain, validCachedModel, type EngineMode, type EngineReply, type EngineRequest, type PlainModel } from '../src/core/engine';
import { approxBytes, digestOf, Hash128, ResultCache, resultKey, type DiskStore } from '../src/core/resultCache';
import { createShadowJobHandler, ShadowClient } from '../src/core/shadowJob';
import { carveShadow, carveShadowSteps } from '../src/core/shadow';
import type { Project } from '../src/core/project';
import { smallProject } from './small-project';
import { shadowFrameGray } from './engine-fixtures';

const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const post = <T>(x: T): T => structuredClone(x);
const summary = (m: Model) =>
  JSON.stringify({ plates: m.sliced.plates.length, parts: m.sliced.parts, issues: m.issues, nested: m.nested, moulds: m.moulds, bom: m.bom, shadow: m.shadow?.scores ?? null });

/** Browser storage stand-in: copies in and out, as IndexedDB does. */
function memoryDisk(): DiskStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k) => (map.has(k) ? post(map.get(k)) : undefined),
    put: async (k, m) => void map.set(k, post(m)),
    clear: async () => map.clear(),
    usage: async () => ({ entries: map.size, bytes: [...map.values()].reduce((a: number, m) => a + approxBytes(m), 0) }),
  };
}

/** Drives a handler the way the page and the worker entry do. */
function engine(opts: Parameters<typeof createEngineHandler>[0] = {}) {
  const handle = createEngineHandler(opts);
  let sent: Partial<Project> | null = null;
  let plain: unknown;
  let id = 0;
  const fold = (reply: EngineReply) => {
    if ('error' in reply) throw new Error(reply.error);
    plain = applyDelta(plain, post(reply.model));
    return { model: modelFromPlain(plain as PlainModel), reply };
  };
  const send = (project: Project, assets: Assets, mode: EngineMode) => {
    const changes: Partial<Project> = {};
    for (const [k, x] of Object.entries(project)) if (!sent || (sent as Record<string, unknown>)[k] !== x) (changes as Record<string, unknown>)[k] = x;
    const first = !sent;
    sent = { ...project };
    const req = post({ id: ++id, mode, project: changes, dropped: [], assets: first ? { ...assets, insMesh: null, srcMesh: null } : {} } satisfies EngineRequest);
    handle.apply(req);
    return req;
  };
  return {
    handle,
    run: (project: Project, assets: Assets, mode: EngineMode) => fold(handle.build(send(project, assets, mode).id, mode)),
    /** As the worker entry: read browser storage first. */
    runAsync: async (project: Project, assets: Assets, mode: EngineMode) => {
      const req = send(project, assets, mode);
      const key = handle.key();
      if (key && mode === 'full') await opts.cache!.load(key);
      return fold(handle.build(req.id, mode));
    },
    /** Builds the newest request again (what the worker does when a carve lands). */
    again: () => fold(handle.build(id, 'full')),
  };
}

describe('result cache key', () => {
  it('follows what the engine reads, not names, locks or key order', () => {
    const p = smallProject();
    const k = resultKey(p, none);
    expect(resultKey(post(p), none)).toBe(k);
    expect(resultKey({ ...p, name: 'Renamed', locks: { erosionAmp: true }, variants: [] }, none)).toBe(k);
    const reordered = Object.fromEntries(Object.entries(p.params).reverse());
    expect(resultKey({ ...p, params: reordered }, none)).toBe(k);
    expect(resultKey({ ...p, params: { ...p.params, erosionAmp: '31' } }, none)).not.toBe(k);
    // the curve settings (plan PR 3) are parameters, so they are in the key
    for (const id of ['curveStep', 'curveSmooth', 'curveTolerance', 'sampleStep']) expect(resultKey({ ...p, params: { ...p.params, [id]: '0.3' } }, none)).not.toBe(k);
    // and so is a map's own spec, which lives in the project
    expect(resultKey({ ...p, images: { top: { name: 'm', dataUrl: 'x', map: { terraced: true } as never } } }, none)).not.toBe(k);
    expect(resultKey(p, { ...none, sideImg: { w: 2, h: 1, data: new Float32Array([0, 1]) } })).not.toBe(k);
    // a missing asset and a null one are the same thing
    expect(resultKey(p, { ...none, shadowFrames: undefined })).toBe(k);
  });

  it('hashes bytes, not just lengths, and remembers each object', () => {
    const a = { data: new Float32Array([1, 2, 3]) };
    const b = { data: new Float32Array([1, 2, 4]) };
    expect(digestOf(a)).not.toBe(digestOf(b));
    expect(digestOf(a)).toBe(digestOf({ data: new Float32Array([1, 2, 3]) }));
    const h1 = new Hash128();
    h1.str('ab');
    const h2 = new Hash128();
    h2.str('ba');
    expect(h1.digest()).not.toBe(h2.digest());
    expect(h1.digest()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ResultCache', () => {
  it('drops the least recently used model past its memory budget', () => {
    const c = new ResultCache({ memoryBytes: 2500 });
    const blob = () => ({ x: new Uint8Array(1000) });
    c.put('a', blob());
    c.put('b', blob());
    c.peek('a'); // a is now the most recent
    c.put('c', blob());
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
  });

  it('brings a model in from disk once and then serves it from memory', async () => {
    const disk = memoryDisk();
    await disk.put('k', { m: 1 }, 10);
    const c = new ResultCache({ disk });
    expect(c.peek('k')).toBeUndefined();
    expect(await c.load('k')).toBe(true);
    expect(c.peek('k')?.source).toBe('disk');
    expect(c.peek('k')?.source).toBe('memory');
    expect(await c.load('nothing')).toBe(false);
  });

  it('refuses a damaged entry', async () => {
    const disk = memoryDisk();
    await disk.put('k', { partMeshes: [], sliced: { parts: [{}] } }, 10);
    const c = new ResultCache({ disk, valid: validCachedModel });
    expect(await c.load('k')).toBe(false);
  });
});

describe('engine with the result cache', () => {
  it('answers undo and redo from memory with no pipeline work, and the model is the same', () => {
    const cache = new ResultCache();
    const run = engine({ cache }).run;
    const p = smallProject();
    const a = run(p, none, 'full');
    expect(a.reply).not.toHaveProperty('cached');
    const edited = { ...p, params: { ...p.params, erosionAmp: '33' } };
    const b = run(edited, none, 'full');
    expect(b.reply).not.toHaveProperty('cached');
    // undo: the store puts the old project back
    const t0 = performance.now();
    const u = run(p, none, 'full');
    const ms = performance.now() - t0;
    expect(u.reply).toMatchObject({ cached: 'memory', mode: 'full' });
    expect(u.model.stages.every((s) => s.cached)).toBe(true);
    expect(summary(u.model)).toBe(summary(a.model));
    expect(ms).toBeLessThan(100);
    // redo
    const r = run(edited, none, 'full');
    expect(r.reply).toMatchObject({ cached: 'memory' });
    expect(summary(r.model)).toBe(summary(b.model));
  });

  it('never keeps a preview, and a preview never reads the cache', () => {
    const cache = new ResultCache();
    const run = engine({ cache }).run;
    const p = smallProject({ sampleStep: '1' });
    run(p, none, 'full');
    const q = { ...p, params: { ...p.params, erosionAmp: '21' } };
    run(q, none, 'preview');
    expect(cache.has(resultKey(q, none))).toBe(false);
    expect(run(p, none, 'preview').reply).not.toHaveProperty('cached');
  });

  it('serves a reopened design from browser storage, equal to the pipeline', async () => {
    const disk = memoryDisk();
    const p = smallProject();
    await engine({ cache: new ResultCache({ disk }) }).runAsync(p, none, 'full');
    expect(disk.map.size).toBe(1);
    // a new page: nothing in memory, the stage caches cold
    const fresh = engine({ cache: new ResultCache({ disk }) });
    const m = await fresh.runAsync(post(p), none, 'full');
    expect(m.reply).toMatchObject({ cached: 'disk' });
    expect(summary(m.model)).toBe(summary(createPipeline()(p, none)));
    expect(fresh.handle.built()).toBe(false);
    fresh.handle.warm();
    expect(fresh.handle.built()).toBe(true);
  });
});

describe('shadow worker', () => {
  const ports: MessagePort[] = [];
  afterEach(() => ports.splice(0).forEach((p) => p.close()));

  const shadowProject = (n = 3) => {
    const frames = Array.from({ length: n }, (_, i) => shadowFrameGray(i));
    const p = smallProject({ sunOn: true, shadowOn: true, sunMonth: '12', sunDay: '21', sunLat: '51.5', sunLon: '0', sunUtc: '0', shadowW: '120', shadowH: '80', insertOn: false, shadowDays: '0' });
    p.shadow = { frames: frames.map((_, i) => ({ id: `f${i}`, name: `F${i}`, dataUrl: `data:x${i}`, time: 11.75 + i * 0.25, hold: 0 })) };
    return { p, assets: { ...none, shadowFrames: frames } };
  };

  /** The engine's client wired to a shadow job handler over a real channel; resolves `carved` each time a carve lands. */
  const wire = () => {
    const ch = new MessageChannel();
    ports.push(ch.port1, ch.port2);
    let landed: () => void = () => {};
    const client = new ShadowClient(() => landed());
    const handle = createShadowJobHandler((r) => ch.port2.postMessage(r), () => new Promise((r) => setImmediate(r)));
    ch.port2.onmessage = (e) => void handle(e.data);
    client.attach(ch.port1);
    return { client, carved: () => new Promise<void>((r) => (landed = r)) };
  };

  it('shows the plates at once, then the carve, the same as carving inline', async () => {
    const { p, assets } = shadowProject();
    const { client, carved } = wire();
    const e = engine({ cache: new ResultCache(), shadow: client });
    const waiting = carved();
    const first = e.run(p, assets, 'full');
    expect(first.reply).toMatchObject({ carving: true });
    expect(first.model.shadow).toBeNull();
    expect(first.model.sliced.plates.length).toBeGreaterThan(0);
    await waiting;
    const done = e.again();
    expect(done.reply).not.toHaveProperty('carving');
    expect(done.model.shadow?.scores.length).toBe(3);
    expect(summary(done.model)).toBe(summary(createPipeline()(p, assets)));
  });

  it('carves the plates after an edit that slices them again', async () => {
    // the slice is shared with the one before it, which must not split the parts from their plates
    const frames = [shadowFrameGray(1)];
    const p = smallProject({ shadowOn: true, shadowLight: 'candle', stackHeight: '90', insertOn: false, candleD: '150', shadowW: '200', shadowH: '130' });
    p.shadow = { frames: [{ id: 'f0', name: 'F0', dataUrl: 'data:x0', time: 12, hold: 0 }] };
    const assets = { ...none, shadowFrames: frames };
    const { client, carved } = wire();
    const e = engine({ shadow: client });
    e.run({ ...p, params: { ...p.params, shadowOn: false, stackHeight: '97' } }, assets, 'full');
    const waiting = carved();
    expect(e.run(p, assets, 'full').reply).toMatchObject({ carving: true });
    await waiting;
    const done = e.again().model;
    const inline = createPipeline()(p, assets);
    // the carve cut something, and the engine's plates have it
    expect(inline.sliced.parts).not.toEqual(createPipeline()({ ...p, params: { ...p.params, shadowOn: false } }, assets).sliced.parts);
    expect(summary(done)).toBe(summary(inline));
  });

  it('a Sun edit shows the plates at once without slicing again', async () => {
    const { p, assets } = shadowProject();
    const { client, carved } = wire();
    const e = engine({ shadow: client });
    let waiting = carved();
    e.run(p, assets, 'full');
    await waiting;
    e.again();
    waiting = carved();
    const sun = { ...p, params: { ...p.params, sunDay: '20' } };
    const quick = e.run(sun, assets, 'full');
    expect(quick.reply).toMatchObject({ carving: true });
    expect(quick.model.stages.find((s) => s.name === 'Slice plates')?.cached).toBe(true);
    await waiting;
    expect(summary(e.again().model)).toBe(summary(createPipeline()(sun, assets)));
  });

  it('stops a carve when a newer one arrives', async () => {
    const replies: number[] = [];
    // hands back control after every step
    const handle = createShadowJobHandler((r) => replies.push(r.id), () => new Promise((r) => setImmediate(r)), 0);
    const { p, assets } = shadowProject();
    const sliced = createPipeline()({ ...p, params: { ...p.params, shadowOn: false } }, assets).sliced;
    const v = createPipeline()(p, assets).v;
    const frames = assets.shadowFrames.map((gray, i) => ({ gray, time: 11.75 + i * 0.25, hold: 0 }));
    const first = handle({ id: 1, v, sliced, frames });
    const second = handle({ id: 2, v, sliced, frames: null });
    await Promise.all([first, second]);
    expect(replies).toEqual([2]);
    // and a cancel stops one without a newer carve
    const third = handle({ id: 3, v, sliced, frames: null });
    await handle({ id: 4, cancel: true });
    await third;
    expect(replies).toEqual([2]);
  });

  it('carves the same step by step as in one go', () => {
    const { p, assets } = shadowProject(2);
    const m = createPipeline()(p, assets);
    const frames = assets.shadowFrames.map((gray, i) => ({ gray, time: 11.75 + i * 0.25, hold: 0 }));
    const base = createPipeline()({ ...p, params: { ...p.params, shadowOn: false } }, assets).sliced;
    const steps = carveShadowSteps(m.v, base, frames);
    let n = 0;
    let r = steps.next();
    while (!r.done) (n++, (r = steps.next()));
    expect(n).toBeGreaterThan(2);
    const once = carveShadow(m.v, base, frames);
    expect(JSON.stringify(r.value.sliced.parts)).toBe(JSON.stringify(once.sliced.parts));
  });
});
