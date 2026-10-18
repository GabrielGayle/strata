import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildEaUpstreamHeaders, eaProxyErrorStatus, fetchEaUpstream, parseAllowedEaProxyTarget } from './eaCorsProxy';

function readQueryUrl(req: IncomingMessage): string | undefined {
  const raw = req.url ?? '';
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?')) : raw;
  const params = new URLSearchParams(q);
  return params.get('url') ?? undefined;
}

/** Shared EA proxy handler for Vite middleware and Vercel (`api/ea-proxy.ts`). */
export async function handleEaProxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'GET or HEAD only' }));
    return;
  }
  const target = readQueryUrl(req);
  if (!target) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing url query parameter' }));
    return;
  }
  let upstream: URL;
  try {
    upstream = parseAllowedEaProxyTarget(target);
  } catch (e) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  const range = (req.headers.range as string | undefined) ?? null;
  const headers = buildEaUpstreamHeaders({ method, targetUrl: upstream.href, range });
  try {
    const proxied = await fetchEaUpstream(upstream, { method, headers });
    res.statusCode = proxied.status;
    for (const [k, v] of Object.entries(proxied.headers)) res.setHeader(k, v);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(Buffer.from(proxied.body ?? new ArrayBuffer(0)));
  } catch (e) {
    res.statusCode = eaProxyErrorStatus(e);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Upstream failed: ${(e as Error).message}` }));
  }
}
