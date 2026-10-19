// Web Worker entry: see engine.ts. Requests that arrive while a build runs wait
// in `queue`; the next build takes them all and builds only the newest. A full
// build first looks in the result cache (memory, then browser storage), and a
// shadow carve runs on the shadow worker, which answers over its own port.
import { createEngineHandler, validCachedModel, type EngineControl, type EngineMode, type EngineRequest } from './engine';
import { ResultCache } from './resultCache';
import { idbDiskStore } from './resultCacheIdb';
import { ShadowClient } from './shadowJob';

const cache = new ResultCache({ disk: idbDiskStore(), valid: validCachedModel });
const shadow = new ShadowClient(() => {
  // the carve is in: build the newest request again, if it was a full one (a preview doesn't carve)
  if (last && last.mode === 'full') enqueue({ id: last.id, mode: 'full', project: {}, dropped: [], assets: {} });
});
const handle = createEngineHandler({ cache, shadow });
let queue: EngineRequest[] = [];
let last: { id: number; mode: EngineMode } | null = null;
let running = false;

self.onmessage = (e: MessageEvent<EngineRequest | EngineControl>) => {
  const m = e.data;
  if ('type' in m) {
    if (m.type === 'shadow-port') shadow.attach(m.port);
    else {
      cache.clearMemory();
      shadow.clear();
    }
    return;
  }
  last = { id: m.id, mode: m.mode };
  enqueue(m);
};

function enqueue(req: EngineRequest) {
  queue.push(req);
  if (!running) {
    running = true;
    setTimeout(() => void drain().finally(() => (running = false)));
  }
}

async function drain() {
  while (queue.length) {
    const reqs = queue;
    queue = [];
    reqs.forEach(handle.apply);
    const { id, mode } = reqs[reqs.length - 1];
    if (mode === 'full') {
      const key = handle.key();
      // reading browser storage lets newer edits arrive; if any did, build those instead
      if (key && !cache.has(key)) {
        await cache.load(key);
        if (queue.length) continue;
      }
    }
    self.postMessage(handle.build(id, mode));
    if (!queue.length) handle.warm();
  }
}
