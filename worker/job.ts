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
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { artifactPath, geoJobKey, validateGeoJobRequest } from '../api/_lib/geoJob.js';
import { runTerrainJob } from '../src/core/cloudTerrain';
import { ENGINE_BUILD } from '../src/core/resultCache';

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
  if (!outFile && !token) {
    process.stderr.write('error: no Blob token (RENDER_CACHE_READ_WRITE_TOKEN) in the worker environment\n');
    return 1;
  }
  const key = await geoJobKey(req);
  const t0 = performance.now();
  progress(0.05, 'starting');
  const asset = await runTerrainJob(req, {
    cacheDir: process.env.STRATA_MAP_CACHE || undefined,
    allowOverpassNetwork: true,
    onStage: (done, stage) => progress(0.05 + done * 0.85, stage),
  });
  const px = Math.max(asset.depth?.w ?? 0, asset.depth?.h ?? 0);
  asset.map = { ...asset.map!, cloudBuilt: { key, px } };
  const ms = Math.round(performance.now() - t0);
  const gz = gzipSync(JSON.stringify(asset), { level: 6 });
  progress(0.95, 'saving');
  if (outFile) {
    writeFileSync(outFile, gz);
  } else {
    const { put } = await import('@vercel/blob');
    await put(artifactPath(key), gz, {
      access: 'private',
      token: token!,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/gzip',
    });
  }
  process.stdout.write(`${JSON.stringify({ key, px, ms, bytes: gz.length })}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  },
);
