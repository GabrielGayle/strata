/**
 * /api/geo/* — cloud jobs (Boost) for Vercel (`api/geo.ts`) and the Vite middleware.
 *
 *   GET  health                 is the cloud set up, and which engine the worker runs
 *   POST jobs                   start a job (or answer at once from the cloud cache)
 *   GET  jobs/:id               running n% / done / failed / cancelled
 *   POST jobs/:id/cancel
 *   POST inputs/:sha?part=n&parts=N   one part of a design for a pack or nest job ({data: base64})
 *   GET  artifacts/:key?part=n  a finished result, in parts under 4.5 MB
 *   GET  artifacts/:key/:file?part=n    the same for pack.zip and nest.json.gz
 *   GET  usage                  this month's jobs and cost
 *
 * Every route checks the owner passphrase first and makes no Modal or Blob call
 * without it. Modal is reached with a proxy auth token (MODAL_KEY / MODAL_SECRET);
 * neither it nor the Blob token is ever sent to the browser or logged.
 */
import { assertOwner, OwnerAuthError } from './ownerAuth.js';
import {
  ARTIFACT_FILES,
  ARTIFACT_PART_BYTES,
  artifactPath,
  GEO_JOB_MAX_BODY_BYTES,
  GEO_KEY_RE,
  geoJobKey,
  INPUT_MAX_BODY_BYTES,
  INPUT_PART_BYTES,
  inputPartPath,
  MAX_INPUT_PARTS,
  SHA_RE,
  validateGeoJobRequest,
  type GeoJobStatus,
} from './geoJob.js';

export interface GeoApiRequest {
  method: string;
  /** Path after /api/geo/, e.g. "jobs/fc-123". */
  path: string;
  query?: Record<string, string | undefined>;
  authorization?: string;
  body?: unknown;
}

export interface GeoApiResponse {
  status: number;
  json?: unknown;
  /** Binary body (artifact parts). */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

/** The result cache: private Vercel Blob in production, memory in tests. */
export interface RenderCache {
  has(pathname: string): Promise<boolean>;
  get(pathname: string): Promise<Uint8Array | undefined>;
  put(pathname: string, bytes: Uint8Array): Promise<void>;
}

export interface GeoApiDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  cache?: RenderCache;
}

/** How long one call to the Modal API may take before the cloud counts as unreachable. */
const MODAL_TIMEOUT_MS = 15_000;

export interface ModalConfig {
  url: string;
  key: string;
  secret: string;
}

export function modalConfig(env: NodeJS.ProcessEnv = process.env): ModalConfig | undefined {
  const url = env.MODAL_GEO_URL?.trim().replace(/\/+$/, '');
  const key = env.MODAL_KEY?.trim();
  const secret = env.MODAL_SECRET?.trim();
  if (!url || !key || !secret || !/^https:\/\//.test(url)) return undefined;
  return { url, key, secret };
}

export function renderCacheToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RENDER_CACHE_READ_WRITE_TOKEN?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
}

/** Private Blob store holding results (`strata-render-cache`, or the projects store as a fallback). */
export function blobRenderCache(token: string): RenderCache {
  return {
    async has(pathname) {
      const { head, BlobNotFoundError } = await import('@vercel/blob');
      try {
        await head(pathname, { token });
        return true;
      } catch (e) {
        if (e instanceof BlobNotFoundError) return false;
        throw e;
      }
    },
    async get(pathname) {
      const { get } = await import('@vercel/blob');
      const r = await get(pathname, { access: 'private', token, useCache: true });
      if (!r || r.statusCode !== 200) return undefined;
      return new Uint8Array(await new Response(r.stream).arrayBuffer());
    },
    async put(pathname, bytes) {
      const { put } = await import('@vercel/blob');
      await put(pathname, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: 'private',
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/octet-stream',
      });
    },
  };
}

class GeoError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
  }
}

function jsonBody(body: unknown, max = GEO_JOB_MAX_BODY_BYTES): unknown {
  if (body == null || body === '') return {};
  if (typeof body === 'string') {
    if (body.length > max) throw new GeoError(413, 'Request too large');
    try {
      return JSON.parse(body);
    } catch {
      throw new GeoError(400, 'Request is not JSON');
    }
  }
  if (JSON.stringify(body).length > max) throw new GeoError(413, 'Request too large');
  return body;
}

async function callModal(cfg: ModalConfig, f: typeof fetch, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await f(`${cfg.url}${path}`, {
      method,
      headers: { 'Modal-Key': cfg.key, 'Modal-Secret': cfg.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
    });
  } catch {
    throw new GeoError(502, 'The cloud worker did not answer', 'unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new GeoError(502, 'The cloud worker refused the proxy token', 'not-configured');
  if (!res.ok) throw new GeoError(502, `The cloud worker answered ${res.status}`, 'unreachable');
  return res.json();
}

function requireModal(env: NodeJS.ProcessEnv): ModalConfig {
  const cfg = modalConfig(env);
  if (!cfg) throw new GeoError(503, 'Cloud jobs are not configured (MODAL_GEO_URL, MODAL_KEY, MODAL_SECRET)', 'not-configured');
  return cfg;
}

function requireCache(deps: GeoApiDeps, env: NodeJS.ProcessEnv): RenderCache {
  if (deps.cache) return deps.cache;
  const token = renderCacheToken(env);
  if (!token) throw new GeoError(503, 'The result store is not configured (RENDER_CACHE_READ_WRITE_TOKEN)', 'not-configured');
  return blobRenderCache(token);
}

const CACHE_ID_PREFIX = 'cache-';

export async function handleGeoApi(req: GeoApiRequest, deps: GeoApiDeps = {}): Promise<GeoApiResponse> {
  const env = deps.env ?? process.env;
  const f = deps.fetch ?? fetch;
  try {
    assertOwner(req.authorization, env);
  } catch (e) {
    if (e instanceof OwnerAuthError) return { status: e.status, json: { error: e.message, reason: e.status === 401 ? 'locked' : 'not-configured' } };
    throw e;
  }

  const method = (req.method || 'GET').toUpperCase();
  const parts = req.path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  try {
    if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      const cfg = requireModal(env);
      requireCache(deps, env);
      const h = await callModal(cfg, f, 'GET', '/health');
      return { status: 200, json: { ok: true, engine: typeof h?.engine === 'string' ? h.engine : null } };
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'usage') {
      const cfg = requireModal(env);
      return { status: 200, json: await callModal(cfg, f, 'GET', '/usage') };
    }

    if (method === 'POST' && parts.length === 1 && parts[0] === 'jobs') {
      const checked = validateGeoJobRequest(jsonBody(req.body));
      if (!checked.ok) return { status: 400, json: { error: checked.error } };
      const cfg = requireModal(env);
      const cache = requireCache(deps, env);
      const key = await geoJobKey(checked.value);
      if (await cache.has(artifactPath(key, ARTIFACT_FILES[checked.value.kind]))) {
        const done: GeoJobStatus = { id: `${CACHE_ID_PREFIX}${key}`, status: 'done', key, cached: true };
        return { status: 200, json: done };
      }
      if (checked.value.kind !== 'terrain') {
        // the worker reads the design from the store: every part must be there first
        const input = checked.value.input;
        const missing: number[] = [];
        for (let i = 0; i < input.parts; i++) if (!(await cache.has(inputPartPath(input, i)))) missing.push(i);
        if (missing.length) return { status: 409, json: { error: 'Upload the design first', reason: 'needs-input', missing } };
      }
      const started = await callModal(cfg, f, 'POST', '/jobs', checked.value);
      if (typeof started?.id !== 'string') throw new GeoError(502, 'The cloud worker did not start the job', 'unreachable');
      const running: GeoJobStatus = { id: started.id, status: 'running', progress: 0, stage: 'queued' };
      return { status: 202, json: { ...running, key } };
    }

    if (parts[0] === 'jobs' && parts.length >= 2) {
      const id = parts[1];
      if (id.startsWith(CACHE_ID_PREFIX)) {
        const key = id.slice(CACHE_ID_PREFIX.length);
        if (!GEO_KEY_RE.test(key)) return { status: 400, json: { error: 'Invalid job id' } };
        if (method === 'GET' && parts.length === 2) return { status: 200, json: { id, status: 'done', key, cached: true } };
        if (method === 'POST' && parts[2] === 'cancel') return { status: 200, json: { id, status: 'done', key, cached: true } };
      }
      if (!/^fc-[A-Za-z0-9]{1,64}$/.test(id)) return { status: 400, json: { error: 'Invalid job id' } };
      const cfg = requireModal(env);
      if (method === 'GET' && parts.length === 2) {
        return { status: 200, json: await callModal(cfg, f, 'GET', `/jobs/${id}`) };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
        return { status: 200, json: await callModal(cfg, f, 'POST', `/jobs/${id}/cancel`) };
      }
    }

    if (method === 'POST' && parts.length === 2 && parts[0] === 'inputs') {
      const sha = parts[1];
      const part = Number(req.query?.part);
      const count = Number(req.query?.parts);
      if (!SHA_RE.test(sha)) return { status: 400, json: { error: 'Invalid input' } };
      if (!Number.isInteger(count) || count < 1 || count > MAX_INPUT_PARTS || !Number.isInteger(part) || part < 0 || part >= count) {
        return { status: 400, json: { error: 'Invalid part' } };
      }
      const body = jsonBody(req.body, INPUT_MAX_BODY_BYTES) as { data?: unknown };
      if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return { status: 400, json: { error: 'data must be base64' } };
      const bytes = Uint8Array.from(Buffer.from(body.data, 'base64'));
      if (bytes.length === 0 || bytes.length > INPUT_PART_BYTES) return { status: 413, json: { error: 'Part too large' } };
      const cache = requireCache(deps, env);
      await cache.put(inputPartPath({ sha, parts: count }, part), bytes);
      return { status: 200, json: { ok: true, part, bytes: bytes.length } };
    }

    if (method === 'GET' && (parts.length === 2 || parts.length === 3) && parts[0] === 'artifacts') {
      const key = parts[1];
      const file = parts[2] ?? ARTIFACT_FILES.terrain;
      if (!GEO_KEY_RE.test(key)) return { status: 400, json: { error: 'Invalid result key' } };
      if (!Object.values(ARTIFACT_FILES).includes(file)) return { status: 400, json: { error: 'Invalid result file' } };
      const part = Number(req.query?.part ?? 0);
      if (!Number.isInteger(part) || part < 0) return { status: 400, json: { error: 'Invalid part' } };
      const cache = requireCache(deps, env);
      const all = await cache.get(artifactPath(key, file));
      if (!all) return { status: 404, json: { error: 'Result not found' } };
      const total = Math.max(1, Math.ceil(all.length / ARTIFACT_PART_BYTES));
      if (part >= total) return { status: 404, json: { error: 'No such part' } };
      return {
        status: 200,
        bytes: all.subarray(part * ARTIFACT_PART_BYTES, (part + 1) * ARTIFACT_PART_BYTES),
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Strata-Parts': String(total),
          // a key names one result forever
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      };
    }

    return { status: 404, json: { error: 'Not found' } };
  } catch (e) {
    if (e instanceof GeoError) return { status: e.status, json: { error: e.message, ...(e.reason ? { reason: e.reason } : {}) } };
    return { status: 500, json: { error: 'Cloud request failed', reason: 'failed' } };
  }
}
