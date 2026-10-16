/** EA Defra CORS proxy helpers (ticket T6). Colocated under `api/` so Vercel Node ESM can resolve them. */

export const EA_ALLOWED_HOST = 'environment.data.gov.uk';

export const EA_PROXY_MAX_REDIRECTS = 5;

/** Response headers forwarded to the browser (never `set-cookie`). */
export const EA_PROXY_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
]);

export function isAllowedEaDataGovHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === EA_ALLOWED_HOST) return true;
  const suffix = `.${EA_ALLOWED_HOST}`;
  if (!h.endsWith(suffix) || h.length <= suffix.length) return false;
  const prefix = h.slice(0, -suffix.length);
  if (!prefix || prefix.includes('..')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(prefix);
}

/** Reject any target that is not HTTPS on environment.data.gov.uk (no other map hosts). */
export function parseAllowedEaProxyTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid proxy URL');
  }
  if (url.protocol !== 'https:') throw new Error('Only https targets allowed');
  if (!isAllowedEaDataGovHost(url.hostname)) {
    throw new Error(`Host not allowed (only ${EA_ALLOWED_HOST}): ${url.hostname}`);
  }
  return url;
}

export interface EaProxyRequest {
  method: string;
  targetUrl: string;
  range?: string | null;
}

export function buildEaUpstreamHeaders(req: EaProxyRequest): Record<string, string> {
  const headers: Record<string, string> = { Accept: '*/*' };
  if (req.range) headers.Range = req.range;
  return headers;
}

export function pickEaProxyResponseHeaders(from: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  from.forEach((value, name) => {
    const k = name.toLowerCase();
    if (k === 'set-cookie' || k === 'transfer-encoding') return;
    if (!EA_PROXY_RESPONSE_HEADERS.has(k)) return;
    out[k] = value;
  });
  return out;
}

export interface EaUpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

/** Fetch with `redirect: manual` and re-validate the allowlist on every hop. */
export async function fetchEaUpstream(
  startUrl: URL,
  opts: { method: string; headers: Record<string, string>; fetchImpl?: typeof fetch },
): Promise<EaUpstreamResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = startUrl;
  for (let hop = 0; hop <= EA_PROXY_MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url.href, { method: opts.method, headers: opts.headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Redirect without Location header');
      url = parseAllowedEaProxyTarget(new URL(loc, url.href).href);
      continue;
    }
    const headers = pickEaProxyResponseHeaders(res.headers);
    const body = opts.method === 'HEAD' ? null : await res.arrayBuffer();
    return { status: res.status, headers, body };
  }
  throw new Error('Too many redirects');
}
