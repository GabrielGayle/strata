// /api/geo (plan PR 8): every route needs the owner passphrase before any Modal or Blob call,
// results come from the cache when they exist, and secrets never reach a response.
import { describe, expect, it, vi } from 'vitest';
import { handleGeoApi, type RenderCache } from '../api/_lib/geoApi';
import { ARTIFACT_PART_BYTES, artifactPath, geoJobKey, type TerrainJobRequest } from '../api/_lib/geoJob';
import { NEASDEN_BBOX } from './map-fixtures';

const env = {
  STRATA_OWNER_TOKEN: 'owner-pass',
  MODAL_GEO_URL: 'https://example--strata-cloud-api.modal.run/',
  MODAL_KEY: 'wk-secret-key',
  MODAL_SECRET: 'ws-secret-value',
  RENDER_CACHE_READ_WRITE_TOKEN: 'vercel_blob_rw_secret',
} as NodeJS.ProcessEnv;
const auth = 'Bearer owner-pass';

const request: TerrainJobRequest = {
  kind: 'terrain',
  engine: 'abc123',
  maxPx: 2048,
  spec: { kind: 'map', bbox: NEASDEN_BBOX, source: 'ea-dtm', model: 'dtm', resM: 0, exaggeration: 'auto', water: 'flat', engrave: { enabled: false, features: [] }, attribution: [] },
  stack: { plateCount: 93, thicknessMm: 1.5, masterWidthMm: 520 },
};

function memoryCache(init: Record<string, Uint8Array> = {}): RenderCache & { files: Record<string, Uint8Array> } {
  const files = { ...init };
  return {
    files,
    has: async (p) => p in files,
    get: async (p) => files[p],
  };
}

function modal(reply: (url: string, init: RequestInit) => unknown = () => ({})) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(reply(String(url), init ?? {})), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const ROUTES: [string, string, unknown?][] = [
  ['GET', 'health'],
  ['GET', 'usage'],
  ['POST', 'jobs', request],
  ['GET', 'jobs/fc-abc'],
  ['POST', 'jobs/fc-abc/cancel'],
  ['GET', `artifacts/${'a'.repeat(32)}`],
];

describe('/api/geo', () => {
  it('answers 401 without the owner token and makes no Modal or Blob call', async () => {
    for (const [method, path, body] of ROUTES) {
      for (const authorization of [undefined, 'Bearer wrong']) {
        const fetch = modal();
        const cache = memoryCache();
        const has = vi.spyOn(cache, 'has');
        const get = vi.spyOn(cache, 'get');
        const out = await handleGeoApi({ method, path, authorization, body }, { env, fetch, cache });
        expect(out.status, `${method} ${path}`).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
        expect(has).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
      }
    }
  });

  it('answers 503 when the server has no owner token', async () => {
    const out = await handleGeoApi({ method: 'GET', path: 'health', authorization: auth }, { env: { ...env, STRATA_OWNER_TOKEN: '' }, fetch: modal() });
    expect(out.status).toBe(503);
  });

  it('says "not configured" when Modal is not set up', async () => {
    const fetch = modal();
    const out = await handleGeoApi({ method: 'GET', path: 'health', authorization: auth }, { env: { STRATA_OWNER_TOKEN: 'owner-pass' }, fetch });
    expect(out.status).toBe(503);
    expect(out.json).toMatchObject({ reason: 'not-configured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the worker engine on health, calling Modal with the proxy token', async () => {
    const fetch = modal(() => ({ ok: true, engine: 'abc123' }));
    const out = await handleGeoApi({ method: 'GET', path: 'health', authorization: auth }, { env, fetch, cache: memoryCache() });
    expect(out).toMatchObject({ status: 200, json: { ok: true, engine: 'abc123' } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example--strata-cloud-api.modal.run/health');
    expect(init.headers).toMatchObject({ 'Modal-Key': 'wk-secret-key', 'Modal-Secret': 'ws-secret-value' });
  });

  it('refuses bad requests before calling Modal', async () => {
    const bad: unknown[] = [
      { ...request, kind: 'pack' },
      { ...request, maxPx: 4096 },
      { ...request, engine: '' },
      { ...request, spec: { ...request.spec, bbox: [1, 2, 0, 3] } },
      { ...request, spec: { ...request.spec, bbox: [-3, 54, -1, 55] } },
      { ...request, stack: { plateCount: 0, thicknessMm: 1, masterWidthMm: 500 } },
      'x'.repeat(70 * 1024),
    ];
    for (const body of bad) {
      const fetch = modal();
      const out = await handleGeoApi({ method: 'POST', path: 'jobs', authorization: auth, body }, { env, fetch, cache: memoryCache() });
      expect([400, 413]).toContain(out.status);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('answers from the cache without starting a job', async () => {
    const key = await geoJobKey({ ...request, spec: request.spec });
    const cache = memoryCache({ [artifactPath(key)]: new Uint8Array([1]) });
    const fetch = modal();
    const out = await handleGeoApi({ method: 'POST', path: 'jobs', authorization: auth, body: JSON.stringify(request) }, { env, fetch, cache });
    expect(out).toMatchObject({ status: 200, json: { status: 'done', key, cached: true } });
    expect(fetch).not.toHaveBeenCalled();
    const again = await handleGeoApi({ method: 'GET', path: `jobs/cache-${key}`, authorization: auth }, { env, fetch, cache });
    expect(again.json).toMatchObject({ status: 'done', key });
  });

  it('starts a job on a cache miss, then polls and cancels it on Modal', async () => {
    const fetch = modal((url) => (url.endsWith('/jobs') ? { id: 'fc-01ABC' } : url.endsWith('/cancel') ? { id: 'fc-01ABC', status: 'cancelled' } : { id: 'fc-01ABC', status: 'running', progress: 0.4 }));
    const cache = memoryCache();
    const started = await handleGeoApi({ method: 'POST', path: 'jobs', authorization: auth, body: request }, { env, fetch, cache });
    expect(started).toMatchObject({ status: 202, json: { id: 'fc-01ABC', status: 'running', key: await geoJobKey(request) } });
    const sent = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(sent.engine).toBe('abc123');
    const poll = await handleGeoApi({ method: 'GET', path: 'jobs/fc-01ABC', authorization: auth }, { env, fetch, cache });
    expect(poll.json).toMatchObject({ status: 'running', progress: 0.4 });
    const cancel = await handleGeoApi({ method: 'POST', path: 'jobs/fc-01ABC/cancel', authorization: auth }, { env, fetch, cache });
    expect(cancel.json).toMatchObject({ status: 'cancelled' });
    expect(fetch.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'https://example--strata-cloud-api.modal.run/jobs',
      'https://example--strata-cloud-api.modal.run/jobs/fc-01ABC',
      'https://example--strata-cloud-api.modal.run/jobs/fc-01ABC/cancel',
    ]);
  });

  it('says "unreachable" when Modal does not answer', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const out = await handleGeoApi({ method: 'POST', path: 'jobs', authorization: auth, body: request }, { env, fetch, cache: memoryCache() });
    expect(out).toMatchObject({ status: 502, json: { reason: 'unreachable' } });
  });

  it('serves a large result in parts under the 4.5 MB response limit', async () => {
    const key = 'b'.repeat(32);
    const big = new Uint8Array(ARTIFACT_PART_BYTES * 2 + 1234).map((_, i) => i & 255);
    const cache = memoryCache({ [artifactPath(key)]: big });
    const parts: Uint8Array[] = [];
    let total = 1;
    for (let i = 0; i < total; i++) {
      const out = await handleGeoApi({ method: 'GET', path: `artifacts/${key}`, query: { part: String(i) }, authorization: auth }, { env, fetch: modal(), cache });
      expect(out.status).toBe(200);
      expect(out.bytes!.length).toBeLessThan(4.5e6);
      total = Number(out.headers!['X-Strata-Parts']);
      parts.push(out.bytes!);
    }
    expect(total).toBe(3);
    expect(Buffer.concat(parts).equals(Buffer.from(big))).toBe(true);
    const missing = await handleGeoApi({ method: 'GET', path: `artifacts/${'c'.repeat(32)}`, authorization: auth }, { env, fetch: modal(), cache });
    expect(missing.status).toBe(404);
    const traversal = await handleGeoApi({ method: 'GET', path: 'artifacts/..%2Fstrata-projects', authorization: auth }, { env, fetch: modal(), cache });
    expect(traversal.status).toBe(400);
  });

  it('never puts a secret in a response', async () => {
    const secrets = [env.MODAL_KEY!, env.MODAL_SECRET!, env.RENDER_CACHE_READ_WRITE_TOKEN!, env.STRATA_OWNER_TOKEN!];
    const fetch = modal((url) => (url.endsWith('/jobs') ? { id: 'fc-1' } : { ok: true, engine: 'x' }));
    for (const [method, path, body] of ROUTES) {
      for (const authorization of [auth, undefined]) {
        const out = await handleGeoApi({ method, path, authorization, body }, { env, fetch, cache: memoryCache() });
        const text = JSON.stringify(out.json ?? {}) + JSON.stringify(out.headers ?? {});
        for (const s of secrets) expect(text).not.toContain(s);
      }
    }
  });
});
