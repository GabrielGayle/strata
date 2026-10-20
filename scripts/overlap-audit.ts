// Builds every preset and every project file given and lists metal parts that overlap.
// npx tsx scripts/overlap-audit.ts [file.strata.json | file.strata-library.json ...]
import { readFileSync } from 'node:fs';
import { createFrontPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, deserialize, newProject, PRESETS, type Project } from '../src/core/project';
import { DEFAULT_CANDLES, type CandleSpec } from '../src/core/candles';
import { findOverlaps } from '../src/core/overlap';
import { loadAssets } from '../src/packNode';

const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function projectsIn(file: string): Project[] {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(d.entries)) return d.entries.map((e: { data: string | object }) => deserialize(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)));
  return [deserialize(JSON.stringify(d))];
}

async function audit(label: string, p: Project, assets: Assets) {
  const run = createFrontPipeline({});
  let f;
  try {
    f = run(p, assets);
  } catch (err) {
    console.log(`${label}: build failed: ${(err as Error).message}`);
    return;
  }
  const t0 = performance.now();
  const hits = findOverlaps(f.sliced.parts);
  const ms = performance.now() - t0;
  const fam = [...new Set(f.sliced.parts.map((q) => q.family))].join('');
  console.log(`${label}: ${f.sliced.parts.length} parts [${fam}], ${hits.length} overlap(s), ${ms.toFixed(0)} ms`);
  for (const h of hits.slice(0, 12)) console.log(`   ${h.a.id} × ${h.b.id}: ${h.area.toFixed(1)} mm² at (${h.at[0].toFixed(1)}, ${h.at[1].toFixed(1)})`);
  if (hits.length > 12) console.log(`   … ${hits.length - 12} more`);
}

const preset = (name: string, params: Record<string, string | boolean> = {}, candles?: Partial<CandleSpec>): Project => {
  const p = applyPreset(newProject(), PRESETS.find((q) => q.name === name)!);
  return { ...p, params: { ...p.params, ...params }, ...(candles ? { candles: { ...DEFAULT_CANDLES, ...candles } } : {}) };
};

/** Setups where two metal parts meet: steel base, bracing, support ring, waffle angles, flat stacks, candle fins. */
function scenarios(): [string, Project][] {
  const out: [string, Project][] = [];
  const steel = { baseMaterial: 'steel' };
  for (const n of ['Vermilion 40', 'Waffle field', 'Radial bloom', 'Mini Vermilion', 'Mini waffle', 'Mini radial', 'Sliced vessel', 'Image cliff']) {
    out.push([`${n} · steel base`, preset(n, steel)]);
    out.push([`${n} · steel base, keyholes, no stagger`, preset(n, { ...steel, steelHoles: 'rows', steelHoleStyle: 'keyhole', steelStagger: false })]);
  }
  for (const n of ['Vermilion 40', 'Mini Vermilion', 'Sliced vessel', 'Image cliff']) {
    out.push([`${n} · rods + spacers`, preset(n, { bracingOn: true, rodsOn: true, spacerMode: 'both' })]);
    out.push([`${n} · rods + spacers, angled cross`, preset(n, { bracingOn: true, rodsOn: true, spacerMode: 'both', crossAngle: '30' })]);
    for (const m of ['merge', 'drop', 'keep']) out.push([`${n} · fragments ${m}`, preset(n, { fragmentMode: m })]);
  }
  for (const n of ['Radial bloom', 'Mini radial', 'Vermilion 40']) out.push([`${n} · support ring`, preset(n, { supportMode: 'radial' })]);
  for (const a of ['60', '75', '120', '135']) {
    out.push([`Waffle field · grid ${a}°`, preset('Waffle field', { waffleLayout: 'grid', gridAngle: a })]);
    out.push([`Waffle field · spread ${a}°`, preset('Waffle field', { gridAngle: a })]);
    out.push([`Waffle field · grid ${a}° steel base`, preset('Waffle field', { waffleLayout: 'grid', gridAngle: a, ...steel })]);
  }
  out.push(['Stamped stack · poles + pins', preset('Stamped stack', { stackRodsOn: true, flatPins: '3' })]);
  for (const holder of ['target', 'slotted', 'socket'] as const)
    for (const spin of [0, 30, 45, 60])
      for (const fins of [2, 3, 4, 6])
        for (const sit of ['auto', 'surface'] as const) {
          if (holder === 'socket' && (spin || fins !== 4)) continue;
          out.push([`Vermilion 40 · candles ${holder} ${fins} fins spin ${spin} sit ${sit}`, preset('Vermilion 40', {}, { holder, spin, fins, sit })]);
        }
  for (const choke of ['candles', 'path'] as const) {
    out.push([`Vermilion 40 · candles slotted choke ${choke}`, preset('Vermilion 40', {}, { holder: 'slotted', choke })]);
    out.push([`Vermilion 40 · candles slotted choke ${choke} steel`, preset('Vermilion 40', steel, { holder: 'slotted', choke })]);
  }
  for (const holder of ['target', 'slotted'] as const)
    for (const spin of [0, 45]) out.push([`Vermilion 40 · two-piece fins ${holder} spin ${spin}`, preset('Vermilion 40', {}, { holder, spin, finJoin: 'cross' })]);
  for (const n of ['Vermilion 40', 'Mini Vermilion', 'Waffle field']) out.push([`${n} · steel zig-zag tabs`, preset(n, { ...steel, steelZigzag: true })]);
  out.push(['Waffle field · candles slotted', preset('Waffle field', {}, { holder: 'slotted', size: 300 })]);
  out.push(['Radial bloom · candles target', preset('Radial bloom', {}, { path: 'circle', size: 300 })]);
  return out;
}

const files = process.argv.slice(2);
if (files.includes('--scenarios')) for (const [label, p] of scenarios()) await audit(label, p, none);
if (!files.length || files.includes('--presets')) for (const pr of PRESETS) await audit(`preset ${pr.name}`, applyPreset(newProject(), pr), none);
for (const file of files.filter((x) => !x.startsWith('--')))
  for (const p of projectsIn(file)) await audit(`${file.split('/').pop()} · ${p.name}`, p, await loadAssets(p));
