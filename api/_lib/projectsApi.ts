/** Shared /api/projects handler for Vercel (`api/projects.ts`) and Vite middleware. */

import { assertOwner, OwnerAuthError } from './ownerAuth.js';
import {
  assertProjectId,
  PROJECT_ID_RE,
  StoreNotConfiguredError,
  updatedAtOf,
  type LibraryMeta,
  type LibraryStore,
} from './projectStore.js';

export interface ProjectsApiRequest {
  method: string;
  id?: string;
  authorization?: string;
  body?: unknown;
}

export interface ProjectsApiResponse {
  status: number;
  json: unknown;
}

export interface ProjectsApiDeps {
  store: LibraryStore;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

function isMeta(raw: unknown): raw is LibraryMeta {
  if (!raw || typeof raw !== 'object') return false;
  const m = raw as LibraryMeta;
  return typeof m.id === 'string' && PROJECT_ID_RE.test(m.id) && typeof m.name === 'string' && Number.isFinite(m.savedAt) && Number.isFinite(m.openedAt);
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (body == null || body === '') return {};
  if (typeof body === 'string') {
    const t = body.trim();
    if (!t) return {};
    return JSON.parse(t) as Record<string, unknown>;
  }
  if (typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

export async function handleProjectsApi(req: ProjectsApiRequest, deps: ProjectsApiDeps): Promise<ProjectsApiResponse> {
  const env = deps.env ?? process.env;
  try {
    assertOwner(req.authorization, env);
  } catch (e) {
    if (e instanceof OwnerAuthError) return { status: e.status, json: { error: e.message } };
    throw e;
  }

  const method = (req.method || 'GET').toUpperCase();
  try {
    if (method === 'GET' && !req.id) {
      const entries = await deps.store.list();
      return { status: 200, json: { entries } };
    }

    if (!req.id) return { status: 400, json: { error: 'Missing project id' } };
    const id = assertProjectId(req.id);

    if (method === 'GET') {
      const [meta, data] = await Promise.all([deps.store.getMeta(id), deps.store.getData(id)]);
      if (!meta || data == null) return { status: 404, json: { error: 'Project not found' } };
      return { status: 200, json: { meta, data } };
    }

    if (method === 'DELETE') {
      const old = await deps.store.getMeta(id);
      if (!old) return { status: 404, json: { error: 'Project not found' } };
      await deps.store.remove(id);
      return { status: 200, json: { ok: true, id } };
    }

    if (method === 'PUT') {
      const body = jsonBody(req.body);
      const metaIn = body.meta;
      if (!isMeta(metaIn) || metaIn.id !== id) return { status: 400, json: { error: 'Invalid project meta' } };
      const data = body.data;
      if (data !== undefined && typeof data !== 'string') return { status: 400, json: { error: 'Invalid project data' } };
      const existing = await deps.store.getMeta(id);
      const baseUpdatedAt = typeof body.baseUpdatedAt === 'number' ? body.baseUpdatedAt : undefined;
      const overwrittenNewer = !!(existing && baseUpdatedAt != null && updatedAtOf(existing) > baseUpdatedAt);
      const now = deps.now ?? Date.now();
      const meta: LibraryMeta = {
        ...metaIn,
        updatedAt: Number.isFinite(metaIn.updatedAt) ? (metaIn.updatedAt as number) : now,
      };
      if (data === undefined && !existing) return { status: 404, json: { error: 'Project not found' } };
      await deps.store.put(meta, data);
      return { status: 200, json: { meta, overwrittenNewer } };
    }

    return { status: 405, json: { error: 'GET, PUT or DELETE only' } };
  } catch (e) {
    if (e instanceof StoreNotConfiguredError) return { status: 503, json: { error: e.message } };
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'Invalid project id') return { status: 400, json: { error: msg } };
    return { status: 500, json: { error: msg } };
  }
}
