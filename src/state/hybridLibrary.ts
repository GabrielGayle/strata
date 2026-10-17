/**
 * Named projects: write the local IndexedDB copy first, then the cloud.
 * A failed cloud write never drops the local save. Unfinished uploads sit in
 * a persisted queue and retry when the API is reachable again.
 */
import { deserialize } from '../core/project';
import {
  defaultLibrary,
  exportLibrary,
  fingerprint,
  importLibrary,
  saveAs,
  uniqueName,
  type LibraryMeta,
  type LibraryStore,
} from './library';
import { applyCloudError, defaultCloudLibrary, probeCloud, type CloudLibrary } from './cloudLibrary';
import { isNetworkCloudError, setCloudSync, setCloudWarning } from './cloudSync';
import { readOwnerToken } from './ownerToken';
import {
  dequeuePending,
  hasPendingUploads,
  pendingPut,
  pendingRemove,
  readPending,
  upsertPending,
  type PendingUpload,
} from './pendingUploads';

export const MIGRATED_KEY = 'strata.library.cloud-migrated.v1';
export const MIGRATE_SKIP_KEY = 'strata.library.migrate-skip';

export interface HybridLibraryOpts {
  storage?: Storage;
  now?: () => number;
}

interface HybridSyncer {
  flush: () => Promise<void>;
  hasPending: () => boolean;
}

const syncers: HybridSyncer[] = [];
const lastCloudPrint = new Map<string, string>();
let flushing: Promise<void> | null = null;
/** Starts the backoff timer after a later failed save. Set by `startPendingRetry`. */
let armRetry: (() => void) | null = null;

export function resetHybridSyncers(): void {
  syncers.length = 0;
  lastCloudPrint.clear();
  flushing = null;
  armRetry = null;
}

export function hybridHasPending(): boolean {
  return syncers.some((s) => s.hasPending()) || hasPendingUploads();
}

function leftoverQueued(storage?: Storage): boolean {
  return hasPendingUploads(storage) || syncers.some((s) => s.hasPending());
}

/** Arm the backoff timer when a put/remove/unsynced flush leaves work queued. */
export function armPendingRetry(): void {
  armRetry?.();
}

function markUnsynced(e: unknown, storage?: Storage): void {
  applyCloudError(e);
  if (!leftoverQueued(storage)) return;
  armPendingRetry();
  if (isNetworkCloudError(e)) {
    setCloudSync('offline', e instanceof Error ? e.message : String(e));
    return;
  }
  const status = e && typeof e === 'object' && 'status' in e ? Number((e as { status: unknown }).status) : 0;
  if (status === 401 || status === 503) return;
  setCloudSync('pending', e instanceof Error ? e.message : String(e));
}

function markCaughtUp(storage?: Storage): void {
  if (hasPendingUploads(storage) || syncers.some((s) => s.hasPending())) {
    setCloudSync('pending');
    return;
  }
  setCloudSync('saved');
}

async function snapshotCloud(cloud: CloudLibrary, id: string): Promise<{ meta?: LibraryMeta; data?: string }> {
  const [meta, data] = await Promise.all([cloud.getMeta(id), cloud.getData(id)]);
  return { meta: meta ?? undefined, data };
}

async function keepCloudCopy(local: LibraryStore, cloud: CloudLibrary, meta: LibraryMeta, data: string, now: number): Promise<void> {
  const names = (await local.list()).map((m) => m.name);
  const name = uniqueName(meta.name, names);
  const project = deserialize(data);
  const { meta: preserved, project: saved } = await saveAs(local, { ...project, name }, name, meta.thumb, now);
  const text = await local.getData(preserved.id);
  if (text != null) {
    cloud.lastOverwrittenNewer = false;
    await cloud.put(preserved, text);
    lastCloudPrint.set(preserved.id, fingerprint(text));
  }
  setCloudWarning(`The cloud copy of “${meta.name}” had changed. Kept it as “${saved.name}”.`);
}

async function pushPut(local: LibraryStore, cloud: CloudLibrary, item: PendingUpload, now: () => number, storage?: Storage): Promise<void> {
  const meta = await local.getMeta(item.id);
  const data = await local.getData(item.id);
  if (!meta || data == null) {
    dequeuePending(item.id, storage);
    return;
  }
  const localPrint = fingerprint(data);
  const { meta: cloudMeta, data: cloudData } = await snapshotCloud(cloud, item.id);
  if (cloudData != null && fingerprint(cloudData) === localPrint) {
    lastCloudPrint.set(item.id, localPrint);
    return;
  }
  const expected = item.expectedCloudPrint ?? lastCloudPrint.get(item.id);
  const cloudPrint = cloudData != null ? fingerprint(cloudData) : undefined;
  const cloudChanged = !!(cloudPrint && cloudPrint !== localPrint && expected && cloudPrint !== expected);
  const unknownCloud = !!(cloudPrint && cloudPrint !== localPrint && !expected);
  if ((cloudChanged || unknownCloud) && cloudMeta && cloudData != null) {
    await keepCloudCopy(local, cloud, cloudMeta, cloudData, now());
  }
  cloud.lastOverwrittenNewer = false;
  await cloud.put(meta, data);
  lastCloudPrint.set(item.id, localPrint);
}

async function pushRemove(cloud: CloudLibrary, id: string): Promise<void> {
  await cloud.remove(id);
  lastCloudPrint.delete(id);
}

export function hybridLibrary(
  local: LibraryStore,
  cloud: CloudLibrary,
  tokenOf: () => string | null = readOwnerToken,
  opts: HybridLibraryOpts = {},
): LibraryStore {
  const storage = opts.storage;
  const now = opts.now ?? Date.now;
  const authed = () => !!tokenOf();

  const flush = async () => {
    if (!authed()) return;
    const queued = readPending(storage);
    if (!queued.length) {
      markCaughtUp(storage);
      return;
    }
    setCloudSync('syncing');
    for (const item of queued) {
      try {
        if (item.op === 'remove') await pushRemove(cloud, item.id);
        else await pushPut(local, cloud, item, now, storage);
        dequeuePending(item.id, storage);
      } catch (e) {
        markUnsynced(e, storage);
        return;
      }
    }
    markCaughtUp(storage);
  };

  syncers.push({
    flush,
    hasPending: () => readPending(storage).length > 0,
  });

  return {
    async list() {
      const localList = await local.list();
      if (!authed()) {
        setCloudSync('locked');
        return localList;
      }
      try {
        setCloudSync('syncing');
        const cloudList = await cloud.list();
        const pending = readPending(storage);
        const puts = new Set(pending.filter((p) => p.op === 'put').map((p) => p.id));
        const removed = new Set(pending.filter((p) => p.op === 'remove').map((p) => p.id));
        const byId = new Map(cloudList.map((m) => [m.id, m]));
        for (const m of localList) {
          if (puts.has(m.id)) byId.set(m.id, m);
        }
        for (const id of removed) byId.delete(id);
        if (pending.length) {
          setCloudSync('pending');
          void flushPendingUploads();
        } else {
          setCloudSync('saved');
        }
        return [...byId.values()];
      } catch (e) {
        markUnsynced(e, storage);
        return localList;
      }
    },
    async getMeta(id) {
      if (pendingRemove(id, storage)) return undefined;
      if (pendingPut(id, storage)) return local.getMeta(id);
      if (authed()) {
        try {
          const m = await cloud.getMeta(id);
          if (m) return m;
        } catch (e) {
          applyCloudError(e);
        }
      }
      return local.getMeta(id);
    },
    async getData(id) {
      if (pendingRemove(id, storage)) return undefined;
      if (pendingPut(id, storage)) return local.getData(id);
      if (authed()) {
        try {
          const [m, d] = await Promise.all([cloud.getMeta(id), cloud.getData(id)]);
          if (m && d != null) {
            await local.put(m, d);
            return d;
          }
        } catch (e) {
          applyCloudError(e);
        }
      }
      return local.getData(id);
    },
    async put(meta, data) {
      await local.put(meta, data);
      if (!authed()) {
        setCloudSync('locked', 'Saved in this browser only');
        return;
      }
      const localPrint = typeof data === 'string' ? fingerprint(data) : undefined;
      upsertPending(
        {
          id: meta.id,
          op: 'put',
          localPrint,
          expectedCloudPrint: lastCloudPrint.get(meta.id),
          queuedAt: now(),
        },
        storage,
      );
      setCloudSync('syncing');
      await flushPendingUploads();
      if (leftoverQueued(storage)) {
        armPendingRetry();
        if (readPending(storage).some((p) => p.id === meta.id)) {
          setCloudWarning('Saved in this browser. Waiting to sync to the cloud.');
        }
      }
    },
    async remove(id) {
      await local.remove(id);
      if (!authed()) return;
      upsertPending({ id, op: 'remove', queuedAt: now() }, storage);
      setCloudSync('syncing');
      await flushPendingUploads();
      if (leftoverQueued(storage)) {
        armPendingRetry();
        if (readPending(storage).some((p) => p.id === id)) {
          setCloudWarning('Removed locally. Waiting to sync the delete to the cloud.');
        }
      }
    },
  };
}

export async function flushPendingUploads(): Promise<void> {
  if (flushing) await flushing;
  if (flushing) return flushing;
  flushing = (async () => {
    for (const s of [...syncers]) await s.flush();
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

export function startPendingRetry(
  target: {
    addEventListener: Window['addEventListener'];
    removeEventListener: Window['removeEventListener'];
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    document?: Document;
  } | null = typeof window !== 'undefined' ? window : null,
): () => void {
  if (!target?.addEventListener) return () => {};
  let delay = 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inScheduledFlush = false;
  const clear = () => {
    if (timer !== undefined) target.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (stopped) return;
    if (!hybridHasPending()) {
      delay = 400;
      return;
    }
    if (timer !== undefined || inScheduledFlush) return;
    timer = target.setTimeout(() => {
      timer = undefined;
      inScheduledFlush = true;
      void flushPendingUploads().finally(() => {
        inScheduledFlush = false;
        delay = hybridHasPending() ? Math.min(Math.round(delay * 1.8), 8_000) : 400;
        schedule();
      });
    }, delay);
  };
  const arm = () => {
    if (stopped || inScheduledFlush) return;
    schedule();
  };
  const kick = () => {
    if (stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setCloudSync('offline', 'This browser is offline');
      return;
    }
    delay = 400;
    clear();
    void probeCloud()
      .then(() => flushPendingUploads())
      .finally(schedule);
  };
  const onOff = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) setCloudSync('offline', 'This browser is offline');
  };
  const onVis = () => {
    if (target.document?.visibilityState === 'visible') kick();
  };
  armRetry = arm;
  target.addEventListener('online', kick);
  target.addEventListener('focus', kick);
  target.addEventListener('offline', onOff);
  target.document?.addEventListener('visibilitychange', onVis);
  schedule();
  return () => {
    stopped = true;
    clear();
    if (armRetry === arm) armRetry = null;
    target.removeEventListener('online', kick);
    target.removeEventListener('focus', kick);
    target.removeEventListener('offline', onOff);
    target.document?.removeEventListener('visibilitychange', onVis);
  };
}

let shared: LibraryStore | null = null;

/** Local IndexedDB plus cloud, the store the Projects dialog uses. */
export function defaultProjectLibrary(): LibraryStore {
  return (shared ??= hybridLibrary(defaultLibrary(), defaultCloudLibrary()));
}

export async function migrateLocalToCloud(local: LibraryStore, cloud: LibraryStore): Promise<{ added: string[]; skipped: number }> {
  const { text, count } = await exportLibrary(local);
  if (!count) return { added: [], skipped: 0 };
  return importLibrary(cloud, text);
}

export function localProjectsPendingMigration(localList: LibraryMeta[], cloudList: LibraryMeta[]): LibraryMeta[] {
  const cloudIds = new Set(cloudList.map((m) => m.id));
  return localList.filter((m) => !cloudIds.has(m.id));
}

export function markMigrated(ls?: Storage): void {
  try {
    (ls ?? localStorage).setItem(MIGRATED_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function hasMigrated(ls?: Storage): boolean {
  try {
    return (ls ?? localStorage).getItem(MIGRATED_KEY) === '1';
  } catch {
    return false;
  }
}

export function skipMigrateThisSession(): void {
  try {
    sessionStorage.setItem(MIGRATE_SKIP_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function migrateSkippedThisSession(): boolean {
  try {
    return sessionStorage.getItem(MIGRATE_SKIP_KEY) === '1';
  } catch {
    return false;
  }
}
