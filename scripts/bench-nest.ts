// Sheet nesting before and after: the bounding-box nester Strata had, the outline
// nester the app now runs locally, and the cloud's 30 s tight nest (same code, a budget).
//   npx tsx scripts/bench-nest.ts            [--budget 30] [--only buttermere]
import { readFileSync } from 'node:fs';
import { createFrontPipeline, nestGroupsOf } from '../src/core/pipeline';
import { materialOf } from '../src/core/appearance';
import { deserialize, newProject, type Project } from '../src/core/project';
import { nest, nestBoxes, nestSheetArea, type NestGroup, type NestResult } from '../src/core/nest';
import { loadAssets } from '../src/packNode';
import { vermilion93 } from '../test/engine-fixtures';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const budgetS = Number(flag('--budget') ?? 30);
const only = flag('--only');

const file = (name: string) => () => deserialize(readFileSync(new URL(`../test/fixtures/projects/${name}`, import.meta.url), 'utf8'));
const cases: [string, () => Project][] = [
  ['Vermilion 40 (default)', () => newProject()],
  ['Vermilion 93', () => vermilion93()],
  ['Buttermere Terrarium 77', file('buttermere-terrarium-77.strata.json')],
  ['Neasden build pack', file('neasden-buildpack.strata.json')],
];

function boxesOf(groups: NestGroup[], W: number, H: number, gap: number): NestResult {
  // the old nester, group by group, as pipeline.ts ran it before
  const sheets: NestResult['sheets'] = [];
  const unplaced: string[] = [];
  for (const g of groups) {
    const r = nestBoxes(g.items, W, H, gap);
    for (const s of r.sheets) sheets.push({ ...s, index: sheets.length });
    unplaced.push(...r.unplaced);
  }
  return { sheets, unplaced, sheetW: W, sheetH: H, utilisation: 0, spacing: gap };
}

function nestAll(groups: NestGroup[], W: number, H: number, gap: number, budgetMs: number): NestResult {
  const sheets: NestResult['sheets'] = [];
  const unplaced: string[] = [];
  let tries = 0;
  const total = groups.reduce((a, g) => a + g.items.length, 0);
  for (const g of groups) {
    const r = nest(g.items, W, H, gap, { budgetMs: (budgetMs * g.items.length) / Math.max(1, total) });
    tries += r.tries ?? 0;
    for (const s of r.sheets) sheets.push({ ...s, index: sheets.length });
    unplaced.push(...r.unplaced);
  }
  return { sheets, unplaced, sheetW: W, sheetH: H, utilisation: 0, spacing: gap, tries };
}

const m2 = (a: number) => (a / 1e6).toFixed(3);
for (const [label, make] of cases) {
  if (only && !label.toLowerCase().includes(only)) continue;
  const project = make();
  const assets = await loadAssets(project);
  const f = createFrontPipeline()(project, assets);
  const v = f.v;
  const groups = nestGroupsOf(f.sliced, String(v.plateMaterial), (k) => materialOf(project.appearance, k, String(v.plateMaterial)));
  const parts = groups.reduce((a, g) => a + g.items.length, 0);
  const row = (name: string, run: () => NestResult) => {
    const t0 = performance.now();
    const r = run();
    const ms = performance.now() - t0;
    return { name, r, ms, area: nestSheetArea(r) };
  };
  const before = row('boxes (before)', () => boxesOf(groups, v.sheetW, v.sheetH, v.partSpacing));
  const local = row('outline, local', () => nestAll(groups, v.sheetW, v.sheetH, v.partSpacing, 0));
  const tight = row(`outline, ${budgetS} s`, () => nestAll(groups, v.sheetW, v.sheetH, v.partSpacing, budgetS * 1000));
  console.log(`\n${label}: ${parts} parts, sheet ${v.sheetW} × ${v.sheetH} mm, gap ${v.partSpacing} mm`);
  for (const x of [before, local, tight]) {
    const less = (1 - x.area / before.area) * 100;
    console.log(
      `  ${x.name.padEnd(18)} ${String(x.r.sheets.length).padStart(2)} sheets  ${m2(x.area)} m²  ${less.toFixed(1).padStart(5)}% less  ${x.ms.toFixed(0).padStart(6)} ms${x.r.tries ? `  ${x.r.tries} tries` : ''}${x.r.unplaced.length ? `  ${x.r.unplaced.length} unplaced` : ''}`,
    );
  }
}
