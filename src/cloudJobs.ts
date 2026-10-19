// The pack and nest jobs Boost runs on the cloud worker (worker/job.ts), with the same
// engine as the app. The pack job is `cli export --zip` itself, run on the uploaded
// design; the nest job is the app's own nester given 30 or 90 seconds.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { NEST_BUDGET_MS, type NestJobRequest, type PackJobRequest } from '../api/_lib/geoJob.js';
import { main as cliMain, loadProject } from './cli';
import { materialOf } from './core/appearance';
import { nestFingerprint, nestGroups, nestMismatch, nestSheetArea, type SavedNest } from './core/nest';
import { nestClearanceProblems } from './core/nestCheck';
import { createFrontPipeline, nestGroupsOf } from './core/pipeline';
import { loadAssets } from './packNode';

export interface PackJobResult {
  zip: Uint8Array;
  /** Plates and parts in the zip's manifest, which the app checks against its own slice. */
  meta: { plates: number; parts: number; partFiles: number };
}

/** Plates, parts and part DXFs in a fabrication zip. */
export function packZipCounts(zip: Uint8Array): PackJobResult['meta'] {
  const files = unzipSync(zip, { filter: (f) => f.name === 'manifest.json' || (f.name.startsWith('laser/parts/') && f.name.endsWith('.dxf')) });
  const manifest = files['manifest.json'] ? JSON.parse(strFromU8(files['manifest.json'])) : {};
  return {
    plates: Number(manifest.plateCount) || 0,
    parts: Number(manifest.partCount) || 0,
    partFiles: Object.keys(files).filter((n) => n.startsWith('laser/parts/')).length,
  };
}

/** Run `cli export --zip` on the design. Throws with the CLI's own error on a fit error or a bad file. */
export async function runPackJob(req: PackJobRequest, projectText: string, opts: { allowFaults?: boolean } = {}): Promise<PackJobResult> {
  const dir = mkdtempSync(join(tmpdir(), 'strata-pack-'));
  try {
    const projectFile = join(dir, 'project.strata.json');
    const zipFile = join(dir, 'pack.zip');
    writeFileSync(projectFile, projectText);
    const argv = [projectFile, '--zip', zipFile, '--date', req.date];
    if (req.rates) {
      writeFileSync(join(dir, 'rates.json'), JSON.stringify(req.rates));
      argv.push('--rates', join(dir, 'rates.json'));
    }
    const errors: string[] = [];
    const code = await cliMain(argv, { stdout: () => undefined, stderr: (s) => void errors.push(s.trim()) });
    if (code !== 0) throw new Error(errors.filter((e) => e.startsWith('error')).join('; ').replace(/^error: /, '') || 'export failed');
    let zip: Uint8Array = readFileSync(zipFile);
    if (req.fault === 'drop-plate' && opts.allowFaults) zip = dropOnePlate(zip, new Date(`${req.date}T00:00:00Z`));
    return { zip, meta: packZipCounts(zip) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The development fault: the last part DXF taken out and its plate out of the manifest. */
function dropOnePlate(zip: Uint8Array, date: Date): Uint8Array {
  const files = unzipSync(zip);
  const part = Object.keys(files).filter((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf')).pop();
  if (part) delete files[part];
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  manifest.plateCount -= 1;
  manifest.partCount -= 1;
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  return zipSync(files, { level: 6, mtime: date });
}

export interface NestJobOptions {
  /** Override the budget (tests). */
  budgetMs?: number;
  /** Stop after this many tries instead (tests: a repeatable nest). */
  maxTries?: number;
}

/**
 * The tight nest of the design's metal parts, checked before it goes back: every part
 * placed once at its size, and every part the gap from every other.
 */
export async function runNestJob(req: NestJobRequest, projectText: string, opts: NestJobOptions = {}): Promise<SavedNest> {
  const { project, issues } = loadProject(projectText);
  const bad = issues.find((i) => i.level === 'error');
  if (bad) throw new Error(bad.message);
  // the design's own saved nest is what this replaces, not an input
  delete project.nest;
  const assets = await loadAssets(project);
  const f = createFrontPipeline()(project, assets);
  const v = f.v;
  const groups = nestGroupsOf(f.sliced, String(v.plateMaterial), (k) => materialOf(project.appearance, k, String(v.plateMaterial)));
  const local = nestGroups(groups, v.sheetW, v.sheetH, v.partSpacing);
  const result = nestGroups(groups, v.sheetW, v.sheetH, v.partSpacing, {
    budgetMs: opts.maxTries ? 0 : opts.budgetMs ?? NEST_BUDGET_MS[req.budget],
    maxTries: opts.maxTries,
    seed: req.seed ?? 1,
  });
  const mismatch = nestMismatch(groups, result);
  if (mismatch) throw new Error(`nest check failed: ${mismatch}`);
  const close = nestClearanceProblems(f.sliced.parts, result, v.partSpacing);
  if (close.length) throw new Error(`nest check failed: ${close[0]}`);
  return {
    kind: 'nest',
    fingerprint: nestFingerprint(groups, v.sheetW, v.sheetH, v.partSpacing),
    result,
    budget: req.budget,
    localArea: nestSheetArea(local),
    localSheets: local.sheets.length,
  };
}
