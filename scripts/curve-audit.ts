// Curve quality of map plate tops, as cut: median turn between entities, share of
// turns over 20°, share written as arcs, fit errors, plate count, summit height.
// npx tsx scripts/curve-audit.ts [project.strata.json ...] [--json]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { curveAudit, formatCurveAudit } from '../test/curve/audit';
import { depthToGray } from '../src/core/depth';
import { createFrontPipeline, createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';

const DEFAULTS = ['test/fixtures/projects/buttermere-terrarium-77.strata.json', 'test/fixtures/projects/neasden-buildpack.strata.json'];
const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));

for (const file of files.length ? files : DEFAULTS) {
  const project = deserialize(readFileSync(file, 'utf8'));
  const top = project.images.top?.depth ? depthToGray(project.images.top.depth) : null;
  const assets: Assets = { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null };
  const sliceMs = (preview: boolean) => {
    const f = createFrontPipeline({ preview })(project, assets);
    return Math.round(f.stages.find((s) => s.name === 'Slice plates')?.ms ?? 0);
  };
  const timing = { sliceMs: sliceMs(false), previewSliceMs: sliceMs(true) };
  const t0 = performance.now();
  const model = createPipeline()(project, assets);
  const ms = Math.round(performance.now() - t0);
  const r = curveAudit(model);
  if (json) console.log(JSON.stringify({ file, ms, ...timing, ...r }));
  else console.log(`${file}\nslice ${timing.sliceMs} ms (preview ${timing.previewSliceMs} ms), whole build ${ms} ms\n${formatCurveAudit(r)}\n`);
}
