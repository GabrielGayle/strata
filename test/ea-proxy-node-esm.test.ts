import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiRoot = join(root, 'api');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strata-ea-proxy-esm-'));
  dirs.push(dir);
  return dir;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

function isApiRouteFile(abs: string): boolean {
  const rel = relative(apiRoot, abs).split(sep);
  return !rel.some((part) => part.startsWith('_'));
}

function esbuildBin(): string {
  return createRequire(import.meta.url).resolve('esbuild/bin/esbuild');
}

/** Transpile api/*.ts as Node ESM without bundling (Vercel leaves relative imports intact). */
function compileApiAsNodeEsm(outDir: string): string[] {
  const entries = listTs(apiRoot);
  expect(entries.length, 'expected at least one api/*.ts file').toBeGreaterThan(0);
  execFileSync(
    esbuildBin(),
    [
      ...entries,
      '--format=esm',
      '--platform=node',
      '--target=node22',
      '--log-level=error',
      `--outdir=${outDir}`,
      `--outbase=${apiRoot}`,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return entries.map((src) => join(outDir, relative(apiRoot, src).replace(/\.ts$/, '.js')));
}

const LOAD_RUNNER = `import { pathToFileURL } from 'node:url';
await import(pathToFileURL(process.argv[2]).href);
`;

const EA_HANDLER_RUNNER = `import { pathToFileURL } from 'node:url';

const handlerUrl = process.argv[2];
const allowedCatalog =
  'https://environment.data.gov.uk/geoservices/datasets/13787b9a-26a4-4775-8523-806d13af58fc/wcs';

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('environment.data.gov.uk')) {
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  throw new Error('unexpected fetch ' + url);
};

function mockRes() {
  const r = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(code) {
      r.statusCode = code;
      return r;
    },
    setHeader(name, value) {
      r.headers[name] = value;
    },
    json(body) {
      r.body = body;
    },
    send(body) {
      r.body = body;
    },
    end() {},
  };
  return r;
}

const mod = await import(pathToFileURL(handlerUrl).href);
if (typeof mod.default !== 'function') {
  throw new Error('handler has no default export');
}

const blocked = mockRes();
await mod.default({ method: 'GET', query: { url: 'https://example.com' } }, blocked);

const allowed = mockRes();
await mod.default({ method: 'GET', query: { url: allowedCatalog } }, allowed);

process.stdout.write(
  JSON.stringify({
    blockedStatus: blocked.statusCode,
    blockedBody: blocked.body,
    allowedStatus: allowed.statusCode,
    allowedContentType: allowed.headers['content-type'],
  }),
);
`;

describe('Vercel api handlers as Node ESM', () => {
  it('loads every compiled api/*.ts module with a plain node import', () => {
    const outDir = scratch();
    const compiled = compileApiAsNodeEsm(outDir);
    const loadRunner = join(outDir, 'load-module.mjs');
    writeFileSync(loadRunner, LOAD_RUNNER);

    for (const js of compiled) {
      const src = readFileSync(js, 'utf8');
      for (const match of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        expect(match[1], `Node ESM relative import in ${relative(outDir, js)}`).toMatch(/\.(js|mjs|cjs|json)$/);
      }
      execFileSync(process.execPath, [loadRunner, js], { encoding: 'utf8', cwd: outDir });
    }

    const routes = listTs(apiRoot).filter(isApiRouteFile).map((p) => relative(apiRoot, p));
    expect(routes).toEqual(['ea-proxy.ts', 'geo.ts', 'overpass.ts', 'projects.ts']);
  });

  it('serves 403 for example.com and accepts environment.data.gov.uk', () => {
    const outDir = scratch();
    compileApiAsNodeEsm(outDir);
    const js = join(outDir, 'ea-proxy.js');
    const runner = join(outDir, 'run-handler.mjs');
    writeFileSync(runner, EA_HANDLER_RUNNER);
    const raw = execFileSync(process.execPath, [runner, js], { encoding: 'utf8', cwd: outDir });
    const result = JSON.parse(raw) as {
      blockedStatus: number;
      blockedBody: { error?: string };
      allowedStatus: number;
      allowedContentType: string;
    };
    expect(result.blockedStatus).toBe(403);
    expect(result.blockedBody?.error).toMatch(/not allowed/i);
    expect(result.allowedStatus).toBe(200);
    expect(result.allowedContentType).toMatch(/text\/plain/);
  });
});
