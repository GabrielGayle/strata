import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchOverpassDeduped, fetchOverpassWithMirrors } from '../core/mapOverpassFetch';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function queryFromBody(body: Buffer, contentType: string | undefined): string | null {
  const text = body.toString('utf8');
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(text);
    return params.get('data');
  }
  if (text.trim().startsWith('data=')) {
    const params = new URLSearchParams(text);
    return params.get('data');
  }
  return text.trim() || null;
}

/** POST Overpass queries server-side (avoids browser CORS / forbidden User-Agent). */
export async function handleOverpassProxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.end('POST only');
    return;
  }
  const body = await readBody(req);
  const query = queryFromBody(body, req.headers['content-type']);
  if (!query) {
    res.statusCode = 400;
    res.end('Missing Overpass query');
    return;
  }
  try {
    const json = await fetchOverpassDeduped(query, (q) => fetchOverpassWithMirrors(q));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(json));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end((e as Error).message);
  }
}
