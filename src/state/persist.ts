// Browser autosave. Projects carry their images as data URLs, which outgrow
// localStorage's ~5 MB quickly, so they live in IndexedDB (hundreds of MB).
// localStorage is only the fallback when IndexedDB is unavailable, and the
// old localStorage keys are read once so earlier autosaves carry over.
//
// IndexedDB and localStorage are per-origin. Each Vercel preview URL and
// production (`MAIN_HOST`) is a different origin, so named library saves
// (src/state/library.ts, database `strata-library`) and this autosave
// (`strata`) do not appear on another build. Cloud copy: api/projects.ts.

import { reopeningDb } from './idb';

export interface KV {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const DB = 'strata';
const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function indexedDbKV(idb: IDBFactory): KV {
  const withDb = reopeningDb(
    () =>
      new Promise((res, rej) => {
        const r = idb.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('Storage is blocked by another Strata tab'));
      }),
  );
  return {
    get: (key) => withDb(async (d) => (await req(d.transaction(STORE).objectStore(STORE).get(key))) as string | undefined),
    set: (key, value) =>
      withDb(async (d) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error ?? new Error('Save was aborted (browser storage may be full)'));
        });
      }),
  };
}

export function localStorageKV(ls: Storage): KV {
  return {
    get: async (k) => ls.getItem(k) ?? undefined,
    set: async (k, v) => ls.setItem(k, v),
  };
}

export function memoryKV(init: Record<string, string> = {}): KV {
  const m = new Map(Object.entries(init));
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
}

/** The best store this browser offers; never throws. */
export function defaultKV(): KV {
  try {
    if (typeof indexedDB !== 'undefined') return indexedDbKV(indexedDB);
  } catch {
    /* fall through */
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorageKV(localStorage);
  } catch {
    /* fall through */
  }
  return memoryKV();
}

/** Read a key, falling back to an older localStorage copy (autosaves made before IndexedDB). */
export async function readWithLegacy(kv: KV, key: string, legacy?: Storage): Promise<string | undefined> {
  try {
    const v = await kv.get(key);
    if (v != null) return v;
  } catch {
    /* fall back to the legacy copy */
  }
  try {
    return legacy?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export type SaveStatus = 'saved' | 'saving' | 'failed';

/**
 * Writes the latest value for each key, one write at a time per key, and
 * reports whether everything asked for has reached storage. A failure is
 * reported once per run of failures; the next successful save clears it.
 */
export function createSaver(kv: KV, onStatus: (s: SaveStatus, err?: Error) => void) {
  const pending = new Map<string, string>();
  const busy = new Set<string>();
  let failed = false;
  const report = () => {
    if (failed) return;
    onStatus(pending.size || busy.size ? 'saving' : 'saved');
  };
  const run = async (key: string) => {
    if (busy.has(key)) return;
    const value = pending.get(key);
    if (value === undefined) return;
    pending.delete(key);
    busy.add(key);
    try {
      await kv.set(key, value);
      busy.delete(key);
      if (failed && !pending.size && !busy.size) failed = false;
    } catch (e) {
      busy.delete(key);
      if (!failed) {
        failed = true;
        onStatus('failed', e instanceof Error ? e : new Error(String(e)));
      }
    }
    if (pending.has(key)) await run(key);
    report();
  };
  return {
    save(key: string, value: string) {
      pending.set(key, value);
      report();
      return run(key);
    },
    /** Resolves once every queued write has finished. */
    async flush() {
      while (pending.size || busy.size) {
        await Promise.all([...pending.keys()].map(run));
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    },
  };
}

/**
 * Asks the browser to keep Strata's storage instead of clearing it when the
 * disk runs low (or, in Safari, after a stretch without visits). Browsers may
 * say no; saves still work, they're just "best effort" then.
 */
export async function requestPersistentStorage(nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined): Promise<boolean> {
  try {
    const s = nav?.storage;
    if (!s?.persist) return false;
    if (s.persisted && (await s.persisted())) return true;
    return await s.persist();
  } catch {
    return false;
  }
}

/** The everyday address. Saves made anywhere else stay at that other address. */
export const MAIN_HOST = 'strata-gamma-one.vercel.app';

/**
 * Whether this page is a one-off build address: Vercel gives every build and
 * every branch its own address, and the browser keeps a separate, empty set
 * of saves for each one.
 */
export function isOneOffAddress(host: string): boolean {
  const h = host.toLowerCase();
  return h.endsWith('.vercel.app') && h !== MAIN_HOST;
}
