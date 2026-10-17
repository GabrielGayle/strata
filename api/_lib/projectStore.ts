/**
 * Named-project store used by /api/projects.
 *
 * On Vercel this is a private Blob store (project JSON + embedded images).
 * Locally / in Playwright it is a directory of files, so two origins can share
 * one store without Blob credentials.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const PROJECTS_PREFIX = 'strata-projects/';

export interface LibraryMeta {
  id: string;
  name: string;
  savedAt: number;
  openedAt: number;
  updatedAt?: number;
  thumb?: string;
  size: number;
}

export interface LibraryStore {
  list(): Promise<LibraryMeta[]>;
  getMeta(id: string): Promise<LibraryMeta | undefined>;
  getData(id: string): Promise<string | undefined>;
  put(meta: LibraryMeta, data?: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class StoreNotConfiguredError extends Error {
  constructor(message = 'Vercel Blob is not configured') {
    super(message);
    this.name = 'StoreNotConfiguredError';
  }
}

/** Safe id: matches library.newEntryId and blocks path traversal. */
export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function assertProjectId(id: string): string {
  if (!PROJECT_ID_RE.test(id)) throw new Error('Invalid project id');
  return id;
}

export function updatedAtOf(m: LibraryMeta): number {
  return m.updatedAt ?? m.savedAt;
}

export function dataPath(id: string): string {
  return `${PROJECTS_PREFIX}${assertProjectId(id)}.json`;
}

export function metaPath(id: string): string {
  return `${PROJECTS_PREFIX}${assertProjectId(id)}.meta.json`;
}

export function parseMeta(raw: string): LibraryMeta | undefined {
  try {
    const m = JSON.parse(raw) as LibraryMeta;
    if (!m || typeof m.id !== 'string' || typeof m.name !== 'string') return undefined;
    if (!Number.isFinite(m.savedAt) || !Number.isFinite(m.openedAt)) return undefined;
    return m;
  } catch {
    return undefined;
  }
}

/** In-memory Blob stand-in for tests (same put/get/del/list shape as the SDK wrapper). */
export interface BlobBackend {
  put(pathname: string, body: string): Promise<void>;
  get(pathname: string): Promise<string | undefined>;
  del(pathname: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export function memoryBlobBackend(init: Record<string, string> = {}): BlobBackend {
  const files = new Map(Object.entries(init));
  return {
    put: async (pathname, body) => void files.set(pathname, body),
    get: async (pathname) => files.get(pathname),
    del: async (pathname) => void files.delete(pathname),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)),
  };
}

export function blobProjectStore(backend: BlobBackend): LibraryStore {
  const readMeta = async (id: string) => {
    const raw = await backend.get(metaPath(id));
    return raw ? parseMeta(raw) : undefined;
  };
  return {
    async list() {
      const names = await backend.list(PROJECTS_PREFIX);
      const ids = names.filter((n) => n.endsWith('.meta.json')).map((n) => n.slice(PROJECTS_PREFIX.length, -'.meta.json'.length));
      const out: LibraryMeta[] = [];
      for (const id of ids) {
        if (!PROJECT_ID_RE.test(id)) continue;
        const m = await readMeta(id);
        if (m) out.push(m);
      }
      return out;
    },
    getMeta: (id) => readMeta(id),
    async getData(id) {
      assertProjectId(id);
      return backend.get(dataPath(id));
    },
    async put(meta, data) {
      assertProjectId(meta.id);
      if (data !== undefined) await backend.put(dataPath(meta.id), data);
      await backend.put(metaPath(meta.id), JSON.stringify(meta));
    },
    async remove(id) {
      assertProjectId(id);
      await backend.del(metaPath(id));
      await backend.del(dataPath(id));
    },
  };
}

async function vercelBlobBackend(): Promise<BlobBackend> {
  const { put, get, del, list } = await import('@vercel/blob');
  const access = 'private' as const;
  return {
    async put(pathname, body) {
      await put(pathname, body, {
        access,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 60,
      });
    },
    async get(pathname) {
      const result = await get(pathname, { access, useCache: false });
      if (!result || result.statusCode !== 200) return undefined;
      return new Response(result.stream).text();
    },
    async del(pathname) {
      await del(pathname);
    },
    async list(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        for (const b of page.blobs) out.push(b.pathname);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}

export function memoryProjectStore(): LibraryStore {
  return blobProjectStore(memoryBlobBackend());
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

export function fileProjectStore(dir: string): LibraryStore {
  const ready = mkdir(dir, { recursive: true });
  const metaFile = (id: string) => join(dir, `${assertProjectId(id)}.meta.json`);
  const dataFile = (id: string) => join(dir, `${assertProjectId(id)}.json`);
  const readMeta = async (id: string) => {
    try {
      return parseMeta(await readFile(metaFile(id), 'utf8'));
    } catch {
      return undefined;
    }
  };
  return {
    async list() {
      await ready;
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const out: LibraryMeta[] = [];
      for (const name of names) {
        if (!name.endsWith('.meta.json')) continue;
        const id = name.slice(0, -'.meta.json'.length);
        if (!PROJECT_ID_RE.test(id)) continue;
        const m = await readMeta(id);
        if (m) out.push(m);
      }
      return out;
    },
    async getMeta(id) {
      await ready;
      return readMeta(id);
    },
    async getData(id) {
      await ready;
      try {
        return await readFile(dataFile(id), 'utf8');
      } catch {
        return undefined;
      }
    },
    async put(meta, data) {
      await ready;
      if (data !== undefined) await writeAtomic(dataFile(meta.id), data);
      await writeAtomic(metaFile(meta.id), JSON.stringify(meta));
    },
    async remove(id) {
      await ready;
      await rm(metaFile(id), { force: true });
      await rm(dataFile(id), { force: true });
    },
  };
}

function unavailableStore(message: string): LibraryStore {
  const fail = async () => {
    throw new StoreNotConfiguredError(message);
  };
  return { list: fail, getMeta: fail, getData: fail, put: fail, remove: fail };
}

export function hasBlobCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.BLOB_READ_WRITE_TOKEN?.trim() || (env.BLOB_STORE_ID?.trim() && env.VERCEL_OIDC_TOKEN?.trim()));
}

let shared: Promise<LibraryStore> | LibraryStore | null = null;

export function defaultLocalProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRATA_PROJECTS_DIR?.trim() || join(process.cwd(), '.strata-projects');
}

/**
 * Blob when Vercel credentials exist; otherwise a directory (so preview origins
 * share state). On Vercel without Blob, operations 503 rather than writing /tmp.
 */
export function createProjectStore(env: NodeJS.ProcessEnv = process.env): LibraryStore | Promise<LibraryStore> {
  if (env.STRATA_PROJECTS_BACKEND === 'memory') {
    return (shared as LibraryStore) ?? (shared = memoryProjectStore());
  }
  if (hasBlobCreds(env)) {
    return (shared as Promise<LibraryStore>) ?? (shared = vercelBlobBackend().then(blobProjectStore));
  }
  if (env.VERCEL && !env.STRATA_PROJECTS_DIR?.trim()) {
    return unavailableStore(
      'Vercel Blob is not configured. Create a private Blob store named strata-projects and attach BLOB_READ_WRITE_TOKEN on Production and Preview.',
    );
  }
  return fileProjectStore(env.STRATA_PROJECTS_DIR?.trim() || defaultLocalProjectsDir(env));
}

/** Tests: drop the process-wide store singleton. */
export function resetProjectStoreSingleton(): void {
  shared = null;
}

export function e2eDefaultProjectsDir(port: number): string {
  return join(tmpdir(), `strata-e2e-projects-${port}`);
}
