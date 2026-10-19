import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGeoApi } from '../../api/_lib/geoApi.js';
import { INPUT_MAX_BODY_BYTES } from '../../api/_lib/geoJob.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // the largest body is an upload part; handleGeoApi checks each route's own limit
    if (size > INPUT_MAX_BODY_BYTES) break;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Shared /api/geo/* handler for Vite middleware (dev + preview). */
export async function handleGeoHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = (req.method ?? 'GET').toUpperCase();
  const auth = req.headers.authorization;
  const out = await handleGeoApi({
    method,
    path: url.pathname.replace(/^\/api\/geo\/?/, ''),
    query: { part: url.searchParams.get('part') ?? undefined, parts: url.searchParams.get('parts') ?? undefined },
    authorization: Array.isArray(auth) ? auth[0] : auth,
    body: method === 'POST' ? await readBody(req) : undefined,
  });
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (out.bytes) {
    res.end(Buffer.from(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength));
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out.json));
}
