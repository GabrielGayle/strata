/**
 * Vercel serverless EA CORS proxy (ticket T6). **Not deployed** from this repository.
 * Whitelists only `environment.data.gov.uk` hosts.
 */
import { buildEaUpstreamHeaders, parseAllowedEaProxyTarget } from '../src/server/eaCorsProxy';

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
    const proxied = await fetch(upstream.href, { method: req.method ?? 'GET', headers });
    res.status(proxied.status);
    proxied.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(k, v);
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.send(Buffer.from(await proxied.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: `Upstream failed: ${(e as Error).message}` });
  }
}
