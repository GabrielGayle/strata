/**
 * Vercel serverless cloud project library. Private Blob (or a local directory
 * when Blob isn't configured). Gated by STRATA_OWNER_TOKEN.
 *
 * Relative imports keep the `.js` suffix so Node ESM on Vercel can load them
 * (see test/ea-proxy-node-esm.test.ts / PR #87).
 */
import { handleProjectsApi } from './_lib/projectsApi.js';
import { createProjectStore } from './_lib/projectStore.js';

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

function queryId(query: VercelReq['query']): string | undefined {
  const raw = query?.id;
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
}

function authorization(headers: VercelReq['headers']): string | undefined {
  return headers?.authorization ?? headers?.Authorization;
}

export default async function handler(req: VercelReq, res: VercelRes) {
  const store = await Promise.resolve(createProjectStore());
  const result = await handleProjectsApi(
    {
      method: req.method ?? 'GET',
      id: queryId(req.query),
      authorization: authorization(req.headers),
      body: req.body,
    },
    { store },
  );
  res.status(result.status);
  res.setHeader('Content-Type', 'application/json');
  res.json(result.json);
}
