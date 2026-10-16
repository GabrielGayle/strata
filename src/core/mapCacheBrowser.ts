/** Browser map cache (IndexedDB) for ticket T7 — optional; tests use an in-memory store. */

const DB_NAME = 'strata-map-cache';
const STORE = 'entries';

let memory: Map<string, string> | null = null;

export function useInMemoryMapCache(): void {
  memory = new Map();
}

export function clearInMemoryMapCache(): void {
  memory?.clear();
}

function memKey(kind: string, key: string): string {
  return `${kind}:${key}`;
}

export async function browserMapCacheGet(kind: string, key: string): Promise<string | null> {
  if (memory) return memory.get(memKey(kind, key)) ?? null;
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE, 'readonly');
      const get = tx.objectStore(STORE).get(memKey(kind, key));
      get.onsuccess = () => resolve((get.result as string | undefined) ?? null);
      get.onerror = () => reject(get.error);
    };
  });
}

export async function browserMapCacheSet(kind: string, key: string, value: string): Promise<void> {
  if (memory) {
    memory.set(memKey(kind, key), value);
    return;
  }
  if (typeof indexedDB === 'undefined') return;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, memKey(kind, key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}
