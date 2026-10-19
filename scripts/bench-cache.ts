// Times the result cache and the shadow worker against building without them.
// npx tsx scripts/bench-cache.ts
import { applyDelta, createEngineHandler, type EngineMode, type EngineRequest } from '../src/core/engine';
import type { Assets } from '../src/core/pipeline';
import type { Project } from '../src/core/project';
import { approxBytes, ResultCache, type DiskStore } from '../src/core/resultCache';
import { createShadowJobHandler, ShadowClient } from '../src/core/shadowJob';
import { shadow8, shadowFrameGray, vermilion93 } from '../test/engine-fixtures';

const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const post = <T>(x: T): T => structuredClone(x);

function driver(opts: Parameters<typeof createEngineHandler>[0]) {
  const handle = createEngineHandler(opts);
  let sent: Partial<Project> | null = null;
  let plain: unknown;
  let id = 0;
  const send = (project: Project, assets: Assets, mode: EngineMode) => {
    const changes: Partial<Project> = {};
    for (const [k, x] of Object.entries(project)) if (!sent || (sent as Record<string, unknown>)[k] !== x) (changes as Record<string, unknown>)[k] = x;
    const first = !sent;
    sent = { ...project };
    handle.apply(post({ id: ++id, mode, project: changes, dropped: [], assets: first ? { ...assets, insMesh: null, srcMesh: null } : {} } satisfies EngineRequest));
  };
  const build = () => {
    const r = handle.build(id, 'full');
    if ('error' in r) throw new Error(r.error);
    plain = applyDelta(plain, post(r.model));
    return r;
  };
  return { handle, send, build };
}

const t = () => performance.now();
const ms = (x: number) => `${x.toFixed(0)} ms`;

// ---- Vermilion 93: undo, and reopening after a reload ----
{
  const disk = new Map<string, unknown>();
  const store: DiskStore = { get: async (k) => post(disk.get(k)), put: async (k, m) => void disk.set(k, post(m)), clear: async () => disk.clear(), usage: async () => ({ entries: disk.size, bytes: 0 }) };
  const p = vermilion93();
  const edited = { ...p, params: { ...p.params, erosionAmp: '47' } };
  for (const cached of [false, true]) {
    const d = driver({ cache: cached ? new ResultCache({ disk: store }) : undefined });
    d.send(p, none, 'full');
    d.build();
    d.send(edited, none, 'full');
    d.build();
    await new Promise((r) => setTimeout(r, 50)); // let the storage writes land
    d.send(p, none, 'full');
    const t0 = t();
    const r = d.build();
    console.log(`Vermilion 93 undo, ${cached ? 'with cache' : 'no cache'}: ${ms(t() - t0)} in the worker${'cached' in r && r.cached ? ` (from ${r.cached})` : ''}`);
  }
  const t0 = t();
  const cache = new ResultCache({ disk: store });
  const d2 = driver({ cache });
  d2.send(post(p), none, 'full');
  await cache.load(d2.handle.key()!);
  const r = d2.build();
  console.log(`Vermilion 93 reopened from storage: ${ms(t() - t0)} (from ${'cached' in r ? r.cached : '?'})`);
  const t1 = t();
  const cold = driver({});
  cold.send(p, none, 'full');
  cold.build();
  console.log(`Vermilion 93 built from scratch: ${ms(t() - t1)}`);
  console.log(`Vermilion 93 model as kept: ${(approxBytes([...disk.values()][0]) / 1e6).toFixed(1)} MB`);
}

// ---- Shadow 8: a Sun edit, carved inline vs on the shadow worker ----
{
  const p = shadow8();
  const assets = { ...none, shadowFrames: Array.from({ length: 8 }, (_, i) => shadowFrameGray(i)) };
  const edit = { ...p, params: { ...p.params, sunDay: '20' } };

  const inline = driver({});
  inline.send(p, assets, 'full');
  inline.build();
  inline.send(edit, assets, 'full');
  let t0 = t();
  inline.build();
  console.log(`Shadow 8 Sun edit, carved inline: plates and carve together after ${ms(t() - t0)}`);

  const ch = new MessageChannel();
  let landed: () => void = () => {};
  const client = new ShadowClient(() => landed());
  const handle = createShadowJobHandler((r) => ch.port2.postMessage(r), () => new Promise((r) => setImmediate(r)));
  ch.port2.onmessage = (e) => void handle(e.data);
  client.attach(ch.port1);
  const d = driver({ shadow: client });
  let carved = new Promise<void>((r) => (landed = r));
  d.send(p, assets, 'full');
  d.build();
  await carved;
  d.build();
  carved = new Promise<void>((r) => (landed = r));
  d.send(edit, assets, 'full');
  t0 = t();
  d.build();
  const plates = t() - t0;
  await carved;
  d.build();
  console.log(`Shadow 8 Sun edit, shadow worker: plates after ${ms(plates)}, carve after ${ms(t() - t0)}`);
  ch.port1.close();
  ch.port2.close();
}
