/**
 * Vercel serverless Overpass proxy — POST OSM queries server-side (User-Agent, mirror failover).
 * Origin check, body cap and query shape live in `api/_lib/overpassProxy.ts` (shared with Vite middleware).
 */
import { handleOverpassProxy } from './_lib/overpassProxy.js';

type VercelReq = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
};

type VercelRes = {
  status: (code: number) => VercelRes;
  setHeader: (name: string, value: string) => void;
  send: (body: string | Buffer) => void;
  end: () => void;
};

export default async function handler(req: VercelReq, res: VercelRes) {
  const h = req.headers ?? {};
  const out = await handleOverpassProxy({
    method: req.method ?? 'GET',
    origin: h.origin,
    secFetchSite: h['sec-fetch-site'],
    host: h['x-forwarded-host'] ?? h.host,
    contentType: h['content-type'],
    body: req.body,
  });
  res.status(out.status);
  res.setHeader('Content-Type', out.contentType);
  res.send(out.body);
}
