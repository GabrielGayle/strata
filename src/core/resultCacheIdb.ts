// The result cache's browser storage: IndexedDB database `strata-render-cache`,
// least recently used first out once it holds more than DISK_BUDGET bytes.
// Used from the engine worker (reads and writes) and the page (reload,
// compare, the Settings menu). Off in `vite dev`, where the engine's code
// changes under a running server and old results would be wrong.
import type { DiskStore } from './resultCache';

export const RESULT_DB = 'strata-render-cache';
/** Most the stored results may take, bytes. */
export const DISK_BUDGET = 300e6;

const MODELS = 'models';
const META = 'meta';

interface Meta {
  bytes: number;
  used: number;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

let opened: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(RESULT_DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(MODELS);
      r.result.createObjectStore(META);
    };
    r.onsuccess = () => {
      // another tab clearing or upgrading: let it
      r.result.onversionchange = () => {
        r.result.close();
        opened = null;
      };
      resolve(r.result);
    };
    r.onerror = () => {
      opened = null;
      reject(r.error);
    };
  });
  return opened;
}

export function resultStorageAvailable() {
  return typeof indexedDB !== 'undefined' && !import.meta.env?.DEV;
}

/** Drops least recently used results until the rest fit the budget. */
async function evict(d: IDBDatabase, budget: number) {
  const tx = d.transaction(META, 'readonly');
  const store = tx.objectStore(META);
  const [keys, metas] = await Promise.all([req(store.getAllKeys()), req(store.getAll() as IDBRequest<Meta[]>)]);
  let total = metas.reduce((a, m) => a + m.bytes, 0);
  if (total <= budget) return;
  const order = keys.map((k, i) => ({ k, m: metas[i] })).sort((a, b) => a.m.used - b.m.used);
  const out = d.transaction([MODELS, META], 'readwrite');
  const finished = done(out);
  for (const { k, m } of order) {
    if (total <= budget) break;
    out.objectStore(MODELS).delete(k);
    out.objectStore(META).delete(k);
    total -= m.bytes;
  }
  await finished;
}

export function idbDiskStore(budget = DISK_BUDGET): DiskStore | null {
  if (!resultStorageAvailable()) return null;
  return {
    async get(key) {
      const d = await db();
      const tx = d.transaction([MODELS, META], 'readwrite');
      const finished = done(tx);
      const model = req(tx.objectStore(MODELS).get(key));
      const metas = tx.objectStore(META);
      const meta = metas.get(key);
      meta.onsuccess = () => meta.result && metas.put({ ...(meta.result as Meta), used: Date.now() }, key);
      await finished;
      return model;
    },
    async put(key, model, bytes) {
      const d = await db();
      const write = async () => {
        const tx = d.transaction([MODELS, META], 'readwrite');
        const finished = done(tx);
        tx.objectStore(MODELS).put(model, key);
        tx.objectStore(META).put({ bytes, used: Date.now() } satisfies Meta, key);
        await finished;
      };
      try {
        await write();
      } catch (e) {
        // full: make room and try once more
        await evict(d, budget / 2);
        await write().catch(() => {
          throw e;
        });
      }
      await evict(d, budget);
    },
    async clear() {
      const d = await db();
      const tx = d.transaction([MODELS, META], 'readwrite');
      const finished = done(tx);
      tx.objectStore(MODELS).clear();
      tx.objectStore(META).clear();
      await finished;
    },
    async usage() {
      const d = await db();
      const metas = (await req(d.transaction(META, 'readonly').objectStore(META).getAll())) as Meta[];
      return { entries: metas.length, bytes: metas.reduce((a, m) => a + m.bytes, 0) };
    },
  };
}
