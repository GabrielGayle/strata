// Time the Neasden terrain build on the offline fixtures: `npx tsx scripts/bench-map.ts [runs] [--dump file]`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { fetchTerrariumGrid } from '../src/core/mapTerrarium';
import { reprojectResample } from '../src/core/mapProject';
import { simplifyMetricGrid } from '../src/core/mapSimplify';
import { resolveExaggerationFactor } from '../src/core/mapExaggeration';
import { sanitizeElevationGrid } from '../src/core/mapElevation';
import { applyLayerBudget, computeLayerBreaks } from '../src/core/mapLayerBudget';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'map');
const NEASDEN_BBOX: [number, number, number, number] = [-0.28, 51.543, -0.233, 51.575];

const fetch = async (url: string) => {
  const m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) throw new Error(`no fixture for ${url}`);
  return readFileSync(join(root, 'neasden', m[1]!, `${m[2]}_${m[3]}.png`));
};
const overpassJson = JSON.parse(readFileSync(join(root, 'overpass-neasden.json'), 'utf8'));
const overpass = async () => overpassJson;

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
const dumpAt = args.indexOf('--dump');
const dump = dumpAt >= 0 ? args[dumpAt + 1] : undefined;

const spec = defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'terrarium' });
const stack = { plateCount: 40, thicknessMm: 3, masterWidthMm: 800, kerfMm: 0.2 };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function time<T>(fn: () => Promise<T> | T): Promise<[T, number]> {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

const totals: number[] = [];
const fetches: number[] = [];
const reprojects: number[] = [];
const simplifies: number[] = [];
const snappedSimplifies: number[] = [];
const exaggerations: number[] = [];
let last: Awaited<ReturnType<typeof buildMapBundle>> | undefined;
for (let i = 0; i < runs + 1; i++) {
  const [bundle, total] = await time(() => buildMapBundle(spec, { fetch, overpass, stack }));
  const [elev, f] = await time(() => fetchTerrariumGrid(spec, { fetch }));
  const [metric, r] = await time(() => reprojectResample(sanitizeElevationGrid(elev), spec));
  const [, s] = await time(() => simplifyMetricGrid(metric, { kerfMm: 0.2, pixelSizeM: Math.abs(metric.transform.pixelW) }));
  const snapped = applyLayerBudget(metric, computeLayerBreaks(metric, stack.plateCount, 'jenks').breaksM);
  const [, ss] = await time(() => simplifyMetricGrid(snapped, { kerfMm: 0.2, pixelSizeM: Math.abs(metric.transform.pixelW) }));
  const [, x] = await time(() => resolveExaggerationFactor({ exaggeration: 'auto' }, metric, stack));
  if (i === 0) continue; // warm-up
  totals.push(total);
  fetches.push(f);
  reprojects.push(r);
  simplifies.push(s);
  snappedSimplifies.push(ss);
  exaggerations.push(x);
  last = bundle;
}

const fmt = (xs: number[]) => `${median(xs).toFixed(1)} ms`;
console.log(`Neasden terrain build, ${runs} runs (median)`);
console.log(`  whole build          ${fmt(totals)}`);
console.log(`  fetch + decode tiles ${fmt(fetches)}`);
console.log(`  reprojectResample    ${fmt(reprojects)}`);
console.log(`  simplifyMetricGrid   ${fmt(simplifies)} (smooth grid), ${fmt(snappedSimplifies)} (terraced grid)`);
console.log(`  auto exaggeration    ${fmt(exaggerations)}`);

if (dump && last) {
  const d = last.depth;
  writeFileSync(
    dump,
    JSON.stringify({
      metric: { w: last.metric.w, h: last.metric.h, data: Array.from(last.metric.data) },
      depth: { w: d.w, h: d.h, minM: d.minM, maxM: d.maxM, data: d.data },
      map: { ...last.asset.map, fetchedAt: undefined },
    }),
  );
  console.log(`  wrote ${dump}`);
}
