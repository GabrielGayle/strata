/**
 * Vercel serverless Overpass proxy — POST OSM queries server-side (CORS / User-Agent).
 * Mirror fallback lives in `api/_lib/overpassFetch.ts` (shared with Vite middleware).
 */
import { fetchOverpassDeduped, fetchOverpassWithMirrors } from './_lib/overpassFetch.js';

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

function queryFromBody(body: unknown, contentType: string | undefined): string | null {
  if (body == null) return null;
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return null;
    if (contentType?.includes('application/x-www-form-urlencoded') || text.startsWith('data=')) {
      return new URLSearchParams(text).get('data');
    }
    return text;
  }
  if (typeof body === 'object' && body !== null && 'data' in body) {
    const data = (body as { data?: unknown }).data;
    return typeof data === 'string' && data.trim() ? data : null;
  }
  return null;
}

export default async function handler(req: VercelReq, res: VercelRes) {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  if (method !== 'POST') {
    res.status(405).send('POST only');
    return;
  }
  const query = queryFromBody(req.body, req.headers?.['content-type']);
  if (!query) {
    res.status(400).send('Missing Overpass query');
    return;
  }
  try {
    const json = await fetchOverpassDeduped(query, (q) => fetchOverpassWithMirrors(q));
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(JSON.stringify(json));
  } catch (e) {
    res.status(502);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send((e as Error).message);
  }
}
