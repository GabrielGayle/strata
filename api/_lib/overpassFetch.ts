/** Overpass mirror POST with timeout, backoff, and in-flight dedupe (Vite + Vercel). */

export const STRATA_OVERPASS_UA = 'StrataMap/0.1 (+https://github.com/GabrielGayle/strata; map engraving)';

export const OVERPASS_MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Per-mirror attempt timeout. Query XML also has [timeout:25]; fail over sooner. */
export const OVERPASS_ATTEMPT_TIMEOUT_MS = 8_000;

/** Browser-only extra proxy retry (Vite/Vercel already walked mirrors). */
export const OVERPASS_BROWSER_RETRY_MS = 500;

const BACKOFF_MS = [0, 400];

const inflight = new Map<string, Promise<unknown>>();

/** Injected by tests so retries never really sleep and never wait on a live 8 s abort. */
let testBackoffMs: readonly number[] | null = null;
let testTimeoutMs: number | null = null;
let testBrowserRetryMs: number | null = null;

export function setOverpassTestDelays(
  opts: { backoffMs?: readonly number[] | null; timeoutMs?: number | null; browserRetryMs?: number | null } | null,
): void {
  if (!opts) {
    testBackoffMs = null;
    testTimeoutMs = null;
    testBrowserRetryMs = null;
    return;
  }
  if ('backoffMs' in opts) testBackoffMs = opts.backoffMs ?? null;
  if ('timeoutMs' in opts) testTimeoutMs = opts.timeoutMs ?? null;
  if ('browserRetryMs' in opts) testBrowserRetryMs = opts.browserRetryMs ?? null;
}

function isVitest(): boolean {
  try {
    // Vite `define` rewrites `process.env` to `{}`, so process.env.VITEST is
    // always missing in transformed modules. Vitest sets import.meta.env.
    const env = import.meta.env;
    if (env && (env.VITEST || env.MODE === 'test')) return true;
  } catch {
    /* Vercel Node has no Vite env */
  }
  try {
    return Boolean((globalThis as { process?: { env?: { VITEST?: string } } }).process?.env?.VITEST);
  } catch {
    return false;
  }
}

export function resolveOverpassBackoffMs(): readonly number[] {
  if (testBackoffMs) return testBackoffMs;
  if (isVitest()) return [0, 0];
  return BACKOFF_MS;
}

export function resolveOverpassTimeoutMs(): number {
  if (testTimeoutMs != null && testTimeoutMs >= 0) return testTimeoutMs;
  return OVERPASS_ATTEMPT_TIMEOUT_MS;
}

export function resolveOverpassBrowserRetryMs(): number {
  if (testBrowserRetryMs != null && testBrowserRetryMs >= 0) return testBrowserRetryMs;
  if (isVitest()) return 0;
  return OVERPASS_BROWSER_RETRY_MS;
}

export function resetOverpassInflight(): void {
  inflight.clear();
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class OverpassFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OverpassFetchError';
    this.status = status;
  }
}

export async function postOverpassEndpoint(
  endpoint: string,
  query: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? resolveOverpassTimeoutMs();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': STRATA_OVERPASS_UA,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: ac.signal,
    });
    if (!res.ok) throw new OverpassFetchError(`Overpass failed (${res.status}) at ${endpoint}`, res.status);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OverpassFetchError(`Overpass non-JSON at ${endpoint}`, res.status);
    }
  } catch (e) {
    if (e instanceof OverpassFetchError) throw e;
    if ((e as Error).name === 'AbortError') throw new OverpassFetchError(`Overpass timeout (${timeoutMs}ms) at ${endpoint}`, 408);
    throw new OverpassFetchError((e as Error).message || `Overpass failed at ${endpoint}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race mirrors in parallel (two passes, short timeout + backoff). A hung host
 * must not block the others — serial 12s walks made /api/overpass sit on 502.
 */
export async function fetchOverpassWithMirrors(
  query: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; mirrors?: readonly string[]; backoffMs?: readonly number[] } = {},
): Promise<unknown> {
  const mirrors = opts.mirrors ?? OVERPASS_MIRRORS;
  const backoff = opts.backoffMs ?? resolveOverpassBackoffMs();
  let last: Error | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const wait = backoff[Math.min(pass, backoff.length - 1)] ?? 0;
    if (wait) await sleep(wait);
    const errors: Error[] = [];
    try {
      return await Promise.any(
        mirrors.map((endpoint) =>
          postOverpassEndpoint(endpoint, query, opts).catch((e) => {
            errors.push(e as Error);
            throw e;
          }),
        ),
      );
    } catch {
      last = errors.find((e) => retryableStatus((e as OverpassFetchError).status ?? 0)) ?? errors[errors.length - 1] ?? last;
    }
  }
  throw last ?? new OverpassFetchError('Overpass unavailable');
}

/** Coalesce concurrent identical Overpass queries (React Strict Mode / overlapping builds). */
export function fetchOverpassDeduped(
  query: string,
  run: (query: string) => Promise<unknown> = (q) => fetchOverpassWithMirrors(q),
): Promise<unknown> {
  const hit = inflight.get(query);
  if (hit) return hit;
  const pending = run(query).finally(() => {
    if (inflight.get(query) === pending) inflight.delete(query);
  });
  inflight.set(query, pending);
  return pending;
}
