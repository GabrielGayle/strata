import type { IncomingMessage, ServerResponse } from 'node:http';
import { OVERPASS_PROXY_MAX_BODY_BYTES, handleOverpassProxy } from '../../api/_lib/overpassProxy.js';

/** Read at most one byte past the cap, so an oversized body is refused without buffering it all. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
    if (size > OVERPASS_PROXY_MAX_BODY_BYTES) break;
  }
  return Buffer.concat(chunks);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** POST Overpass queries server-side (avoids browser CORS / forbidden User-Agent). */
export async function handleOverpassProxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const out = await handleOverpassProxy({
    method,
    origin: header(req, 'origin'),
    secFetchSite: header(req, 'sec-fetch-site'),
    host: header(req, 'x-forwarded-host') ?? header(req, 'host'),
    contentType: header(req, 'content-type'),
    body: method === 'POST' ? await readBody(req) : null,
  });
  res.statusCode = out.status;
  res.setHeader('Content-Type', out.contentType);
  res.end(out.body);
}
