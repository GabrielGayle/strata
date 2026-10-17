import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleProjectsApi } from '../../api/_lib/projectsApi.js';
import { createProjectStore } from '../../api/_lib/projectStore.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Shared /api/projects handler for Vite middleware (dev + preview). */
export async function handleProjectsHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const store = await Promise.resolve(createProjectStore());
  const result = await handleProjectsApi(
    {
      method,
      id: url.searchParams.get('id') ?? undefined,
      authorization: header(req, 'authorization'),
      body: method === 'PUT' ? await readBody(req) : undefined,
    },
    { store },
  );
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result.json));
}
