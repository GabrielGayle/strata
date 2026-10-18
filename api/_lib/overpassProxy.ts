/** Overpass proxy request handling shared by Vercel (`api/overpass.ts`) and Vite (`src/server/overpassProxyHttp.ts`). */
import { fetchOverpassDeduped, fetchOverpassWithMirrors, isBadOverpassQuery } from './overpassFetch.js';

/** Strata's own queries are about 1 KB; anything near this is not ours. */
export const OVERPASS_PROXY_MAX_BODY_BYTES = 16 * 1024;

/** Highest `[timeout:N]` a proxied query may ask the mirror for (ours ask 25). */
export const OVERPASS_PROXY_MAX_QUERY_TIMEOUT_S = 30;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface OverpassProxyRequest {
  method: string;
  /** `Origin` request header. */
  origin?: string;
  /** `Sec-Fetch-Site` request header, used only when `Origin` is missing. */
  secFetchSite?: string;
  /** The host the app is served from (`x-forwarded-host` or `host`). */
  host?: string;
  contentType?: string;
  /** Raw body text, or the object Vercel parsed it into. */
  body: unknown;
}

export interface OverpassProxyResponse {
  status: number;
  contentType: 'application/json' | 'text/plain';
  body: string;
}

function text(status: number, body: string): OverpassProxyResponse {
  return { status, contentType: 'text/plain', body };
}

/** Only the app's own pages (same host, or a local dev server) may use the proxy. */
export function isAllowedOverpassOrigin(req: Pick<OverpassProxyRequest, 'origin' | 'secFetchSite' | 'host'>): boolean {
  if (!req.origin) return req.secFetchSite === 'same-origin';
  let url: URL;
  try {
    url = new URL(req.origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (LOCAL_HOSTS.has(url.hostname)) return true;
  const host = req.host?.split(',')[0]?.trim().toLowerCase();
  return Boolean(host) && url.host.toLowerCase() === host;
}

function bodyText(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body === 'object' && 'data' in body) {
    const data = (body as { data?: unknown }).data;
    return typeof data === 'string' ? `data=${encodeURIComponent(data)}` : null;
  }
  return null;
}

function queryFromText(raw: string, contentType: string | undefined): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (contentType?.includes('application/x-www-form-urlencoded') || t.startsWith('data=')) {
    return new URLSearchParams(t).get('data')?.trim() || null;
  }
  return t;
}

/**
 * The shape of `overpassQueryForBbox`: JSON output, a bounded server timeout, an `out` statement.
 * Returns why a query is refused, or null when it may go upstream.
 */
export function overpassQueryProblem(query: string): string | null {
  const head = /^\[out:json\]\[timeout:(\d{1,3})\]/.exec(query);
  if (!head) return 'Query must start with [out:json][timeout:N]';
  const t = Number(head[1]);
  if (t < 1 || t > OVERPASS_PROXY_MAX_QUERY_TIMEOUT_S) return `Query timeout must be 1 to ${OVERPASS_PROXY_MAX_QUERY_TIMEOUT_S} s`;
  if (/\[maxsize:/i.test(query)) return 'Query may not set maxsize';
  if (!/\bout\b[^;]*;\s*$/.test(query)) return 'Query must end with an out statement';
  return null;
}

export async function handleOverpassProxy(
  req: OverpassProxyRequest,
  run: (query: string) => Promise<unknown> = (q) => fetchOverpassWithMirrors(q),
): Promise<OverpassProxyResponse> {
  if (req.method.toUpperCase() !== 'POST') return text(405, 'POST only');
  if (!isAllowedOverpassOrigin(req)) return text(403, 'Overpass proxy is only for Strata pages on this site');
  const raw = bodyText(req.body);
  if (raw != null && new TextEncoder().encode(raw).length > OVERPASS_PROXY_MAX_BODY_BYTES) {
    return text(413, `Overpass query over ${OVERPASS_PROXY_MAX_BODY_BYTES / 1024} KB`);
  }
  const query = raw == null ? null : queryFromText(raw, req.contentType);
  if (!query) return text(400, 'Missing Overpass query');
  const problem = overpassQueryProblem(query);
  if (problem) return text(400, problem);
  try {
    const json = await fetchOverpassDeduped(query, run);
    return { status: 200, contentType: 'application/json', body: JSON.stringify(json) };
  } catch (e) {
    return text(isBadOverpassQuery(e) ? 400 : 502, (e as Error).message);
  }
}
