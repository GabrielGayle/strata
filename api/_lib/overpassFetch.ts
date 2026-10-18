/** Overpass mirror POST with per-mirror timeout, sequential failover, and in-flight dedupe (Vite + Vercel). */

export const STRATA_OVERPASS_UA = 'StrataMap/0.1 (+https://github.com/GabrielGayle/strata; map engraving)';

export const OVERPASS_MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Per-mirror attempt timeout. Query XML also has [timeout:25]; fail over sooner. */
export const OVERPASS_ATTEMPT_TIMEOUT_MS = 10_000;

/** How long a silent mirror runs alone before the next one starts alongside it. */
export const OVERPASS_HEDGE_MS = 2_500;

/** Browser-only extra proxy retry (Vite/Vercel already walked mirrors). */
export const OVERPASS_BROWSER_RETRY_MS = 500;

const inflight = new Map<string, Promise<unknown>>();

/** Injected by tests so retries never really sleep and never wait on a live 10 s abort. */
let testTimeoutMs: number | null = null;
let testBrowserRetryMs: number | null = null;

export function setOverpassTestDelays(opts: { timeoutMs?: number | null; browserRetryMs?: number | null } | null): void {
  if (!opts) {
    testTimeoutMs = null;
    testBrowserRetryMs = null;
    return;
  }
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
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? resolveOverpassTimeoutMs();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });
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

/** An Overpass 400 means the query itself is bad: another mirror would only say the same. */
export function isBadOverpassQuery(e: unknown): boolean {
  return e instanceof OverpassFetchError && e.status === 400;
}

/**
 * Try mirrors one at a time, each aborted at its own timeout. A mirror that has neither answered
 * nor failed after `hedgeMs` lets the next one start alongside it, so one hung host costs
 * seconds, not the whole timeout. The first answer aborts every request still in flight; a 400
 * (bad query) does too and is thrown, so a bad query normally costs one upstream request.
 */
export async function fetchOverpassWithMirrors(
  query: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; hedgeMs?: number; mirrors?: readonly string[] } = {},
): Promise<unknown> {
  const mirrors = opts.mirrors ?? OVERPASS_MIRRORS;
  const hedgeMs = opts.hedgeMs ?? OVERPASS_HEDGE_MS;
  const controllers: AbortController[] = [];
  const abortAll = () => controllers.forEach((c) => c.abort());
  return new Promise<unknown>((resolve, reject) => {
    let next = 0;
    let pending = 0;
    let settled = false;
    let last: Error | null = null;
    let hedge: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (hedge) clearTimeout(hedge);
      abortAll();
      fn();
    };
    const start = () => {
      if (settled) return;
      if (hedge) clearTimeout(hedge);
      hedge = null;
      if (next >= mirrors.length) {
        if (pending === 0) finish(() => reject(last ?? new OverpassFetchError('Overpass unavailable')));
        return;
      }
      const endpoint = mirrors[next++];
      const ac = new AbortController();
      controllers.push(ac);
      pending++;
      if (next < mirrors.length) hedge = setTimeout(start, hedgeMs);
      postOverpassEndpoint(endpoint, query, { ...opts, signal: ac.signal }).then(
        (json) => finish(() => resolve(json)),
        (e) => {
          pending--;
          if (settled) return;
          if (isBadOverpassQuery(e)) return finish(() => reject(e));
          last = e as Error;
          start();
        },
      );
    };
    start();
  });
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
