/** Overpass mirror POST with timeout, backoff, and in-flight dedupe (Vite + Vercel). */

export const STRATA_OVERPASS_UA = 'StrataMap/0.1 (+https://github.com/GabrielGayle/strata; map engraving)';

export const OVERPASS_MIRRORS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

/** Per-mirror attempt timeout. Query XML also has [timeout:25]; fail over sooner. */
export const OVERPASS_ATTEMPT_TIMEOUT_MS = 12_000;

const BACKOFF_MS = [0, 250, 500, 1000, 2000];

const inflight = new Map<string, Promise<unknown>>();

export function resetOverpassInflight(): void {
  inflight.clear();
}

function sleep(ms: number): Promise<void> {
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
  const timeoutMs = opts.timeoutMs ?? OVERPASS_ATTEMPT_TIMEOUT_MS;
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
 * Walk the mirror list (two passes) with backoff. A 502/429/timeout on one host
 * continues to the next instead of failing the whole query.
 */
export async function fetchOverpassWithMirrors(
  query: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; mirrors?: readonly string[]; backoffMs?: readonly number[] } = {},
): Promise<unknown> {
  const mirrors = opts.mirrors ?? OVERPASS_MIRRORS;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  let last: Error | null = null;
  let attempt = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const endpoint of mirrors) {
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      if (wait) await sleep(wait);
      attempt += 1;
      try {
        return await postOverpassEndpoint(endpoint, query, opts);
      } catch (e) {
        last = e as Error;
        const status = (e as OverpassFetchError).status;
        if (status != null && !retryableStatus(status)) continue;
      }
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
