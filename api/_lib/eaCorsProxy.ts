/** EA Defra CORS proxy helpers (ticket T6). Colocated under `api/` so Vercel Node ESM can resolve them. */

export const EA_ALLOWED_HOST = 'environment.data.gov.uk';

export const EA_PROXY_MAX_REDIRECTS = 5;

/** Whole upstream exchange (redirects and body) must finish within this. */
export const EA_PROXY_TIMEOUT_MS = 20_000;

/** A 1024 px float32 WCS GeoTIFF is about 4 MB; nothing Strata asks for comes near this. */
export const EA_PROXY_MAX_BYTES = 16 * 1024 * 1024;

/** Upstream failure with the status the proxy should answer with. */
export class EaProxyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'EaProxyError';
    this.status = status;
  }
}

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
  // fetch() hands back a decompressed body, so an upstream content-length would be the compressed size.
  const decoded = Boolean(from.get('content-encoding'));
  from.forEach((value, name) => {
    const k = name.toLowerCase();
    if (k === 'set-cookie' || k === 'transfer-encoding') return;
    if (k === 'content-length' && decoded) return;
    if (!EA_PROXY_RESPONSE_HEADERS.has(k)) return;
    out[k] = value;
  });
  return out;
}

function tooLarge(maxBytes: number): EaProxyError {
  return new EaProxyError(
    `EA response is larger than ${Math.round(maxBytes / (1024 * 1024))} MB; choose a smaller area or a lower map resolution`,
    413,
  );
}

/** Read a body, stopping (and cancelling the upstream) once it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw tooLarge(maxBytes);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export interface EaUpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

/**
 * Fetch with `redirect: manual` and re-validate the allowlist on every hop. The whole exchange is
 * bounded by `timeoutMs` (504) and the body by `maxBytes` (413); a declared oversize is refused unread.
 */
export async function fetchEaUpstream(
  startUrl: URL,
  opts: {
    method: string;
    headers: Record<string, string>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<EaUpstreamResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EA_PROXY_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? EA_PROXY_MAX_BYTES;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let url = startUrl;
    for (let hop = 0; hop <= EA_PROXY_MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(url.href, { method: opts.method, headers: opts.headers, redirect: 'manual', signal: ac.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirect without Location header');
        url = parseAllowedEaProxyTarget(new URL(loc, url.href).href);
        continue;
      }
      const headers = pickEaProxyResponseHeaders(res.headers);
      if (opts.method === 'HEAD') return { status: res.status, headers, body: null };
      const declared = Number(res.headers.get('content-length'));
      if (!res.headers.get('content-encoding') && Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      return { status: res.status, headers, body: await readCapped(res, maxBytes) };
    }
    throw new Error('Too many redirects');
  } catch (e) {
    if (ac.signal.aborted) throw new EaProxyError(`EA did not answer within ${Math.round(timeoutMs / 1000)} s`, 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Status for a failed upstream exchange: the proxy's own refusal, else 502. */
export function eaProxyErrorStatus(e: unknown): number {
  return e instanceof EaProxyError ? e.status : 502;
}
