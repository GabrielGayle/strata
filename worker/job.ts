/**
 * Strata cloud job runner: the Node side of the Modal worker (worker/app.py).
 *
 * Reads one job request as JSON on stdin, runs it with the same engine as the
 * browser and the CLI, stores the result in the private Blob store and prints
 * `{ key, px, ms, bytes }` as JSON on stdout. Progress goes to stderr as
 * `@progress <0..1> <stage>` lines, which app.py turns into the job's percentage.
 *
 *   node job.mjs --engine          prints the engine build this bundle was made from
 *   node job.mjs < request.json    runs a job (needs RENDER_CACHE_READ_WRITE_TOKEN or BLOB_READ_WRITE_TOKEN)
 *   node job.mjs --out f.json.gz   writes the result to a file instead of Blob (local testing)
 *   node job.mjs --input p.json    reads a pack or nest job's design from a file instead of Blob
 *
 * Jobs: terrain (a map at up to 2048 px), pack (`cli export --zip` on an uploaded design)
 * and nest (the app's nester given 30 or 90 seconds). STRATA_ALLOW_FAULTS=1 lets a pack
 * request drop a plate on purpose; it is never set on the deployed worker.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ARTIFACT_FILES, artifactPath, geoJobKey, inputPartPath, validateGeoJobRequest, type JobInput } from '../api/_lib/geoJob.js';
import { runTerrainJob } from '../src/core/cloudTerrain';
import { ENGINE_BUILD } from '../src/core/resultCache';
import { runNestJob, runPackJob } from '../src/cloudJobs';

/** Exit codes app.py understands. */
const EXIT_BAD_REQUEST = 2;
const EXIT_OUT_OF_DATE = 3;

function blobToken(): string | undefined {
  return process.env.RENDER_CACHE_READ_WRITE_TOKEN?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/** The uploaded design: its parts joined, gunzipped and checked against its SHA-256. */
async function readInput(input: JobInput, token: string): Promise<string> {
  const { get } = await import('@vercel/blob');
  const parts: Buffer[] = [];
  for (let i = 0; i < input.parts; i++) {
    const r = await get(inputPartPath(input, i), { access: 'private', token });
    if (!r || r.statusCode !== 200) throw new Error(`design part ${i + 1} of ${input.parts} is missing; upload it again`);
    parts.push(Buffer.from(await new Response(r.stream).arrayBuffer()));
  }
  return checkedInput(gunzipSync(Buffer.concat(parts)), input.sha);
}

function checkedInput(bytes: Uint8Array, sha: string): string {
  if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('the uploaded design does not match its checksum; upload it again');
  return new TextDecoder().decode(bytes);
}

function progress(done: number, stage: string): void {
  process.stderr.write(`@progress ${done.toFixed(2)} ${stage}\n`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--engine')) {
    process.stdout.write(`${ENGINE_BUILD}\n`);
    return 0;
  }
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readStdin());
  } catch {
    process.stderr.write('error: request is not JSON\n');
    return EXIT_BAD_REQUEST;
  }
  const checked = validateGeoJobRequest(raw);
  if (!checked.ok) {
    process.stderr.write(`error: ${checked.error}\n`);
    return EXIT_BAD_REQUEST;
  }
  const req = checked.value;
  if (req.engine !== ENGINE_BUILD) {
    process.stderr.write(`error: this worker runs engine ${ENGINE_BUILD} but the app asked for ${req.engine}; redeploy the worker\n`);
    return EXIT_OUT_OF_DATE;
  }
  const token = blobToken();
  const fromBlob = !outFile || (req.kind !== 'terrain' && !argv.includes('--input'));
  if (fromBlob && !token) {
    process.stderr.write('error: no Blob token (RENDER_CACHE_READ_WRITE_TOKEN) in the worker environment\n');
    return 1;
  }
  const key = await geoJobKey(req);
  const t0 = performance.now();
  progress(0.05, 'starting');
  let body: Uint8Array;
  let meta: Record<string, number> = {};
  if (req.kind === 'terrain') {
    const asset = await runTerrainJob(req, {
      cacheDir: process.env.STRATA_MAP_CACHE || undefined,
      allowOverpassNetwork: true,
      onStage: (done, stage) => progress(0.05 + done * 0.85, stage),
    });
    const px = Math.max(asset.depth?.w ?? 0, asset.depth?.h ?? 0);
    asset.map = { ...asset.map!, cloudBuilt: { key, px } };
    meta = { px };
    body = gzipSync(JSON.stringify(asset), { level: 6 });
  } else {
    const inIdx = argv.indexOf('--input');
    const text = inIdx >= 0 ? readFileSync(argv[inIdx + 1], 'utf8') : await readInput(req.input, token!);
    if (inIdx >= 0 && createHash('sha256').update(text).digest('hex') !== req.input.sha) {
      process.stderr.write('error: --input does not match the request sha\n');
      return EXIT_BAD_REQUEST;
    }
    progress(0.15, req.kind === 'pack' ? 'building the pack' : 'nesting');
    if (req.kind === 'pack') {
      const r = await runPackJob(req, text, { allowFaults: process.env.STRATA_ALLOW_FAULTS === '1' });
      body = r.zip;
      meta = r.meta;
    } else {
      const saved = await runNestJob(req, text);
      body = gzipSync(JSON.stringify(saved), { level: 6 });
      meta = { sheets: saved.result.sheets.length, tries: saved.result.tries ?? 0 };
    }
  }
  const ms = Math.round(performance.now() - t0);
  progress(0.95, 'saving');
  if (outFile) {
    writeFileSync(outFile, body);
  } else {
    const { put } = await import('@vercel/blob');
    await put(artifactPath(key, ARTIFACT_FILES[req.kind]), Buffer.from(body), {
      access: 'private',
      token: token!,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: req.kind === 'pack' ? 'application/zip' : 'application/gzip',
    });
  }
  process.stdout.write(`${JSON.stringify({ key, ms, bytes: body.length, meta, ...('px' in meta ? { px: meta.px } : {}) })}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  },
);
