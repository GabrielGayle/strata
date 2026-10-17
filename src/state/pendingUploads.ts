/** Persisted cloud uploads that have not yet reached /api/projects. */

export const PENDING_KEY = 'strata.library.pending-uploads.v1';

export type PendingOp = 'put' | 'remove';

export interface PendingUpload {
  id: string;
  op: PendingOp;
  /** Fingerprint of the local project text we still need to upload. */
  localPrint?: string;
  /** Fingerprint of the cloud copy the last time we successfully synced this id. */
  expectedCloudPrint?: string;
  queuedAt: number;
}

export function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  const store: Storage = {
    get length() {
      return m.size;
    },
    clear() {
      m.clear();
    },
    getItem(key) {
      return m.has(key) ? m.get(key)! : null;
    },
    key(index) {
      return [...m.keys()][index] ?? null;
    },
    removeItem(key) {
      m.delete(key);
    },
    setItem(key, value) {
      m.set(key, value);
    },
  };
  return store;
}

function tryLocalStorage(): Storage | undefined {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* private mode */
  }
  return undefined;
}

export function readPending(ls?: Storage): PendingUpload[] {
  try {
    const raw = (ls ?? tryLocalStorage())?.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is PendingUpload => p && typeof p === 'object' && typeof p.id === 'string' && (p.op === 'put' || p.op === 'remove'));
  } catch {
    return [];
  }
}

export function writePending(items: PendingUpload[], ls?: Storage): void {
  const store = ls ?? tryLocalStorage();
  if (!store) return;
  try {
    if (!items.length) store.removeItem(PENDING_KEY);
    else store.setItem(PENDING_KEY, JSON.stringify(items));
  } catch {
    /* quota */
  }
}

export function upsertPending(item: PendingUpload, ls?: Storage): PendingUpload[] {
  const next = readPending(ls).filter((p) => p.id !== item.id);
  next.push(item);
  writePending(next, ls);
  return next;
}

export function dequeuePending(id: string, ls?: Storage): PendingUpload[] {
  const next = readPending(ls).filter((p) => p.id !== id);
  writePending(next, ls);
  return next;
}

export function hasPendingUploads(ls?: Storage): boolean {
  return readPending(ls).length > 0;
}

export function pendingPut(id: string, ls?: Storage): PendingUpload | undefined {
  return readPending(ls).find((p) => p.id === id && p.op === 'put');
}

export function pendingRemove(id: string, ls?: Storage): boolean {
  return readPending(ls).some((p) => p.id === id && p.op === 'remove');
}
