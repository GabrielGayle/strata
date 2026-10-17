/**
 * Named projects: write the local IndexedDB copy first, then the cloud.
 * A failed cloud write never drops the local save.
 */
import { defaultLibrary, exportLibrary, importLibrary, type LibraryMeta, type LibraryStore } from './library';
import { applyCloudError, defaultCloudLibrary, type CloudLibrary } from './cloudLibrary';
import { setCloudSync } from './cloudSync';
import { readOwnerToken } from './ownerToken';

export const MIGRATED_KEY = 'strata.library.cloud-migrated.v1';
export const MIGRATE_SKIP_KEY = 'strata.library.migrate-skip';

export function hybridLibrary(local: LibraryStore, cloud: CloudLibrary, tokenOf: () => string | null = readOwnerToken): LibraryStore {
  const authed = () => !!tokenOf();
  return {
    async list() {
      if (!authed()) {
        setCloudSync('locked');
        return local.list();
      }
      try {
        setCloudSync('syncing');
        const entries = await cloud.list();
        setCloudSync('saved');
        return entries;
      } catch (e) {
        applyCloudError(e);
        return local.list();
      }
    },
    async getMeta(id) {
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
      try {
        setCloudSync('syncing');
        cloud.lastOverwrittenNewer = false;
        await cloud.put(meta, data);
        setCloudSync('saved');
      } catch (e) {
        applyCloudError(e);
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Saved in this browser, but the cloud copy failed: ${msg}`);
      }
    },
    async remove(id) {
      await local.remove(id);
      if (!authed()) return;
      try {
        setCloudSync('syncing');
        await cloud.remove(id);
        setCloudSync('saved');
      } catch (e) {
        applyCloudError(e);
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Removed locally, but the cloud delete failed: ${msg}`);
      }
    },
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
