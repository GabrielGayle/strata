/** HTTP client for /api/projects. Never imports Node or @vercel/blob. */
import { readOwnerToken } from './ownerToken';
import { setCloudSync, setCloudWarning } from './cloudSync';
import type { LibraryMeta, LibraryStore } from './library';

export class CloudApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
  }
}

export interface CloudLibrary extends LibraryStore {
  lastOverwrittenNewer: boolean;
}

const inflight = new Map<string, Promise<{ meta: LibraryMeta; data: string }>>();

function applyCloudError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const failedFetch = /failed to fetch|networkerror|load failed/i.test(msg);
  if (offline || failedFetch) {
    setCloudSync('offline', msg);
    return;
  }
  const status = e instanceof CloudApiError ? e.status : 0;
  if (status === 401) setCloudSync('error', 'Access token was refused');
  else if (status === 503) setCloudSync('error', msg);
  else setCloudSync('error', msg);
}

async function api(
  fetchImpl: typeof fetch,
  token: string | null,
  method: string,
  id?: string,
  body?: unknown,
): Promise<Response> {
  if (!token) throw new CloudApiError(401, 'Owner token required');
  const url = id ? `/api/projects?id=${encodeURIComponent(id)}` : '/api/projects';
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || res.statusText };
  }
}

function errOf(json: unknown, fallback: string): string {
  if (json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string') {
    return (json as { error: string }).error;
  }
  return fallback;
}

export function createCloudLibrary(opts?: { fetch?: typeof fetch; token?: () => string | null }): CloudLibrary {
  const fetchImpl = opts?.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const tokenOf = opts?.token ?? (() => readOwnerToken());
  const seen = new Map<string, number>();
  const load = (id: string) => {
    let p = inflight.get(id);
    if (!p) {
      p = (async () => {
        const res = await api(fetchImpl, tokenOf(), 'GET', id);
        const json = (await readJson(res)) as { meta?: LibraryMeta; data?: string; error?: string };
        if (!res.ok) throw new CloudApiError(res.status, errOf(json, 'Could not read the cloud project'));
        if (!json.meta || typeof json.data !== 'string') throw new CloudApiError(500, 'Cloud project was incomplete');
        seen.set(json.meta.id, json.meta.updatedAt ?? json.meta.savedAt);
        return { meta: json.meta, data: json.data };
      })();
      inflight.set(id, p);
      void p.finally(() => inflight.delete(id));
    }
    return p;
  };
  const client: CloudLibrary = {
    lastOverwrittenNewer: false,
    async list() {
      const res = await api(fetchImpl, tokenOf(), 'GET');
      const json = (await readJson(res)) as { entries?: LibraryMeta[]; error?: string };
      if (!res.ok) throw new CloudApiError(res.status, errOf(json, 'Could not list cloud projects'));
      const entries = Array.isArray(json.entries) ? json.entries : [];
      for (const m of entries) seen.set(m.id, m.updatedAt ?? m.savedAt);
      return entries;
    },
    async getMeta(id) {
      try {
        return (await load(id)).meta;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return undefined;
        throw e;
      }
    },
    async getData(id) {
      try {
        return (await load(id)).data;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return undefined;
        throw e;
      }
    },
    async put(meta, data) {
      const res = await api(fetchImpl, tokenOf(), 'PUT', meta.id, {
        meta,
        data,
        baseUpdatedAt: seen.get(meta.id),
      });
      const json = (await readJson(res)) as { meta?: LibraryMeta; overwrittenNewer?: boolean; error?: string };
      if (!res.ok) throw new CloudApiError(res.status, errOf(json, 'Could not save to the cloud'));
      client.lastOverwrittenNewer = !!json.overwrittenNewer;
      if (json.overwrittenNewer) {
        setCloudWarning('The cloud copy was newer and was overwritten (last write won).');
      }
      const saved = json.meta ?? meta;
      seen.set(saved.id, saved.updatedAt ?? saved.savedAt);
    },
    async remove(id) {
      const res = await api(fetchImpl, tokenOf(), 'DELETE', id);
      const json = await readJson(res);
      if (!res.ok && res.status !== 404) throw new CloudApiError(res.status, errOf(json, 'Could not delete the cloud project'));
      seen.delete(id);
    },
  };
  return client;
}

let shared: CloudLibrary | null = null;

export function defaultCloudLibrary(): CloudLibrary {
  return (shared ??= createCloudLibrary());
}

export async function probeCloud(cloud: CloudLibrary = defaultCloudLibrary()): Promise<void> {
  if (!readOwnerToken()) {
    setCloudSync('locked');
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setCloudSync('offline', 'This browser is offline');
    return;
  }
  setCloudSync('syncing');
  try {
    await cloud.list();
    setCloudSync('saved');
  } catch (e) {
    applyCloudError(e);
  }
}

export { applyCloudError };
