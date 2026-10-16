import type { IncomingMessage, ServerResponse } from 'node:http';
import { OVERPASS_MIRRORS, STRATA_OVERPASS_UA } from '../core/mapOverpassMirrors';

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
  const form = `data=${encodeURIComponent(query)}`;
  let lastErr = 'Overpass mirrors unavailable';
  for (const endpoint of OVERPASS_MIRRORS) {
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': STRATA_OVERPASS_UA,
        },
        body: form,
      });
      if (!upstream.ok) {
        lastErr = `${endpoint} (${upstream.status})`;
        continue;
      }
      const json = await upstream.text();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(json);
      return;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  res.statusCode = 502;
  res.setHeader('Content-Type', 'text/plain');
  res.end(lastErr);
}
