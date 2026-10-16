/**
 * Vercel serverless EA CORS proxy (ticket T6). Live on Vercel — whitelists only
 * `environment.data.gov.uk` hosts over HTTPS.
 */
import { buildEaUpstreamHeaders, fetchEaUpstream, parseAllowedEaProxyTarget } from './_lib/eaCorsProxy.js';

type VercelReq = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | undefined>;
};

type VercelRes = {
  status: (code: number) => VercelRes;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
  send: (body: string | Buffer) => void;
  end: () => void;
};

export default async function handler(req: VercelReq, res: VercelRes) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'GET or HEAD only' });
    return;
  }
  const raw = req.query?.url;
  const target = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!target) {
    res.status(400).json({ error: 'Missing url query parameter' });
    return;
  }
  let upstream: URL;
  try {
    upstream = parseAllowedEaProxyTarget(target);
  } catch (e) {
    res.status(403).json({ error: (e as Error).message });
    return;
  }
  const range = req.headers?.range ?? req.headers?.Range ?? null;
  const headers = buildEaUpstreamHeaders({ method: req.method ?? 'GET', targetUrl: upstream.href, range });
  try {
    const proxied = await fetchEaUpstream(upstream, { method: req.method ?? 'GET', headers });
    res.status(proxied.status);
    for (const [k, v] of Object.entries(proxied.headers)) res.setHeader(k, v);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.send(Buffer.from(proxied.body ?? new ArrayBuffer(0)));
  } catch (e) {
    res.status(502).json({ error: `Upstream failed: ${(e as Error).message}` });
  }
}
