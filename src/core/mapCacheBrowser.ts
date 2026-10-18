/**
 * Browser map cache (IndexedDB): Terrarium tiles, EA rasters, Overpass and
 * Nominatim answers, keyed as the CLI's on-disk cache is (kind + URL or
 * query). Tests use an in-memory store. Every failure is a cache miss.
 */

const DB_NAME = 'strata-map-cache';
const DB_VERSION = 2;
const STORE = 'entries';
/** Per-key { at, size } so pruning never loads the cached bytes. */
const META = 'meta';
/** Oldest entries go once the cache passes this many bytes. */
export const BROWSER_MAP_CACHE_MAX_BYTES = 200 * 1024 * 1024;

export type MapCacheValue = string | Uint8Array;

interface MetaRow {
  at: number;
  size: number;
}

let memory: Map<string, { value: MapCacheValue; at: number }> | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

export function useInMemoryMapCache(): void {
  memory = new Map();
}

export function clearInMemoryMapCache(): void {
  memory?.clear();
}

function memKey(kind: string, key: string): string {
  return `${kind}:${key}`;
}

function sizeOf(value: MapCacheValue): number {
  return typeof value === 'string' ? value.length * 2 : value.byteLength;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Cached value, or null when absent, older than `maxAgeMs`, or the store is unavailable. */
export async function browserMapCacheGet(kind: string, key: string, maxAgeMs = Infinity): Promise<MapCacheValue | null> {
  const k = memKey(kind, key);
  if (memory) {
    const hit = memory.get(k);
    return hit && Date.now() - hit.at <= maxAgeMs ? hit.value : null;
  }
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, META], 'readonly');
    const value = tx.objectStore(STORE).get(k);
    const meta = tx.objectStore(META).get(k);
    await done(tx);
    const row = meta.result as MetaRow | undefined;
    if (value.result == null || (row && Date.now() - row.at > maxAgeMs)) return null;
    return value.result as MapCacheValue;
  } catch {
    return null;
  }
}

export async function browserMapCacheSet(kind: string, key: string, value: MapCacheValue): Promise<void> {
  const k = memKey(kind, key);
  if (memory) {
    memory.set(k, { value, at: Date.now() });
    return;
  }
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.objectStore(STORE).put(value, k);
    tx.objectStore(META).put({ at: Date.now(), size: sizeOf(value) } satisfies MetaRow, k);
    await done(tx);
    await pruneBrowserMapCache(db);
  } catch {
    /* quota or private mode: run uncached */
  }
}

async function pruneBrowserMapCache(db: IDBDatabase, maxBytes = BROWSER_MAP_CACHE_MAX_BYTES): Promise<void> {
  const read = db.transaction(META, 'readonly');
  const rows: { key: string; at: number; size: number }[] = [];
  const cursorReq = read.objectStore(META).openCursor();
  cursorReq.onsuccess = () => {
    const c = cursorReq.result;
    if (!c) return;
    rows.push({ key: String(c.key), ...(c.value as MetaRow) });
    c.continue();
  };
  await done(read);
  let total = rows.reduce((a, r) => a + r.size, 0);
  if (total <= maxBytes) return;
  rows.sort((a, b) => a.at - b.at);
  const tx = db.transaction([STORE, META], 'readwrite');
  for (const r of rows) {
    if (total <= maxBytes) break;
    tx.objectStore(STORE).delete(r.key);
    tx.objectStore(META).delete(r.key);
    total -= r.size;
  }
  await done(tx);
}

/** Drop every cached tile and answer. */
export async function clearBrowserMapCache(): Promise<void> {
  memory?.clear();
  if (memory || typeof indexedDB === 'undefined') return;
  const db = await openDb();
  const tx = db.transaction([STORE, META], 'readwrite');
  tx.objectStore(STORE).clear();
  tx.objectStore(META).clear();
  await done(tx);
}
