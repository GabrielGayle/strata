/**
 * Vercel serverless cloud jobs (Boost): /api/geo/* is rewritten here with the
 * rest of the path in `?path=` (vercel.json). Routes and checks live in
 * `api/_lib/geoApi.ts`, shared with the Vite middleware.
 */
import { handleGeoApi } from './_lib/geoApi.js';

type VercelReq = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

type VercelRes = {
  status: (code: number) => VercelRes;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
  send: (body: string | Buffer) => void;
  end: () => void;
};

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join('/') : undefined;
}

export default async function handler(req: VercelReq, res: VercelRes) {
  const q = req.query ?? {};
  const out = await handleGeoApi({
    method: req.method ?? 'GET',
    path: one(q.path) ?? '',
    query: { part: one(q.part) },
    authorization: req.headers?.authorization ?? req.headers?.Authorization,
    body: req.body,
  });
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (out.bytes) {
    res.send(Buffer.from(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength));
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out.json);
}
