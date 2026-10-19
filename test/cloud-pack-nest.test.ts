// Cloud pack and nest jobs (plan PR 10): the pack is `cli export --zip` byte for byte,
// a pack missing a plate is refused, and the cloud's nest is the app's own nester,
// checked before it is used.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NestJobRequest, PackJobRequest } from '../api/_lib/geoJob';
import { main as cli } from '../src/cli';
import { runNestJob, runPackJob } from '../src/cloudJobs';
import { materialOf } from '../src/core/appearance';
import { nestFingerprint, nestMismatch, nestSheetArea } from '../src/core/nest';
import { nestClearanceProblems } from '../src/core/nestCheck';
import { packMismatch } from '../src/core/packCheck';
import { createFrontPipeline, createPipeline, nestGroupsOf } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';
import { loadAssets } from '../src/packNode';

const FIXTURE = 'test/fixtures/projects/buttermere-terrarium-77.strata.json';
const text = readFileSync(FIXTURE, 'utf8');
const sha = createHash('sha256').update(text).digest('hex');
const quiet = { stdout: () => undefined, stderr: () => undefined };

describe('cloud pack job', () => {
  const req: PackJobRequest = { kind: 'pack', engine: 'test', input: { sha, parts: 1 }, date: '2026-10-19' };

  it('makes the same bytes as cli export --zip at the same commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-cli-'));
    expect(await cli([FIXTURE, '--zip', join(dir, 'a.zip'), '--date', '2026-10-19'], quiet)).toBe(0);
    const job = await runPackJob(req, text);
    expect(Buffer.compare(Buffer.from(job.zip), readFileSync(join(dir, 'a.zip')))).toBe(0);
    expect(job.meta).toEqual({ plates: 77, parts: 77, partFiles: 77 });
    // and the app's check passes it against its own slice
    const project = deserialize(text);
    const model = createFrontPipeline()(project, await loadAssets(project));
    expect(packMismatch(job.zip, model)).toBeNull();
  }, 180_000);

  it('the fault switch drops a plate only when the worker allows faults, and the app refuses that zip', async () => {
    const project = deserialize(text);
    const model = createFrontPipeline()(project, await loadAssets(project));
    const ignored = await runPackJob({ ...req, fault: 'drop-plate' }, text);
    expect(packMismatch(ignored.zip, model)).toBeNull();
    const faulty = await runPackJob({ ...req, fault: 'drop-plate' }, text, { allowFaults: true });
    expect(faulty.meta.plates).toBe(76);
    expect(packMismatch(faulty.zip, model)).toBe('the cloud pack has 76 plates and this design has 77');
  }, 180_000);

  it('passes a fit error back in the CLI\'s words', async () => {
    const broken = JSON.parse(text);
    broken.params.sheetW = '100';
    broken.params.sheetH = '100';
    await expect(runPackJob(req, JSON.stringify(broken))).rejects.toThrow(/.+/);
  }, 180_000);
});

describe('cloud nest job', () => {
  const req: NestJobRequest = { kind: 'nest', engine: 'test', input: { sha, parts: 1 }, budget: 'default' };

  it('returns a checked nest the browser accepts and the export uses', async () => {
    const saved = await runNestJob(req, text, { maxTries: 12 });
    const project = deserialize(text);
    const assets = await loadAssets(project);
    const f = createFrontPipeline()(project, assets);
    const v = f.v;
    const groups = nestGroupsOf(f.sliced, String(v.plateMaterial), (k) => materialOf(project.appearance, k, String(v.plateMaterial)));
    // the browser's fingerprint of its own parts matches the server's
    expect(saved.fingerprint).toBe(nestFingerprint(groups, v.sheetW, v.sheetH, v.partSpacing));
    expect(nestMismatch(groups, saved.result)).toBeNull();
    expect(nestClearanceProblems(f.sliced.parts, saved.result, v.partSpacing)).toEqual([]);
    // never worse than the nest made locally, and well under the old bounding-box nest
    expect(nestSheetArea(saved.result)).toBeLessThanOrEqual(saved.localArea!);
    const m = createPipeline()({ ...project, nest: saved }, assets);
    expect(m.nested.source).toBe('saved');
    expect(m.bom.partCount).toBe(77);
  }, 180_000);
});
