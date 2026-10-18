// Map grid size on Buttermere from an Environment Agency source: grid, cell size, build time,
// project size and slice time at 77 and 93 plates.
// npx tsx scripts/bench-map-resolution.ts [--cache <dir>] [--json]
// The EA LiDAR service is not reachable from every machine, so the "LiDAR" here is Terrarium
// resampled onto the BNG grid the WCS request would return (same SCALEFACTOR): real terrain,
// real grid sizes and timings, but no 1 m detail.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { curveAudit } from '../test/curve/audit';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';
import { depthToGray } from '../src/core/depth';
import type { Float32Grid } from '../src/core/mapGrid';
import { gridSampleBicubic } from '../src/core/mapGrid';
import { buildMapBundle, mapStackFromProject } from '../src/core/mapPipeline';
import { metricBounds, projectionLattice } from '../src/core/mapProject';
import { defaultMapSpec } from '../src/core/mapSpec';
import { eaWcsScaleFactor } from '../src/core/mapEaWcs';
import { fetchTerrariumGrid } from '../src/core/mapTerrarium';
import { cachedTileFetch } from '../src/core/mapCache';
import { getTileFetcher } from '../src/core/mapTerrarium';
import { createFrontPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, serialize, type Project } from '../src/core/project';

const args = process.argv.slice(2);
const json = args.includes('--json');
const ci = args.indexOf('--cache');
const cacheDir = ci >= 0 ? args[ci + 1] : undefined;

const base = deserialize(readFileSync('test/fixtures/projects/buttermere-terrarium-77.strata.json', 'utf8'));

const inner = getTileFetcher();
const merc = await fetchTerrariumGrid(
  { bbox: BUTTERMERE_BBOX },
  { fetch: (url) => cachedTileFetch(cacheDir, url, (u) => inner(u)) },
);

const standIns = new Map<number, Float32Grid>();

/** Terrarium on the EPSG:27700 grid an EA WCS reply would have for this request (made once, outside the timing). */
function lidarStandIn(spec: { resM?: number; maxSide?: number }): Float32Grid {
  // older builds take two arguments and cap at 512 px
  const cell = 1 / (eaWcsScaleFactor as (...a: unknown[]) => number)(BUTTERMERE_BBOX, spec.resM ?? 8, spec.maxSide ?? 512);
  const hit = standIns.get(cell);
  if (hit) return { ...hit, data: new Float32Array(hit.data) };
  const b = metricBounds(BUTTERMERE_BBOX, 'EPSG:27700');
  const w = Math.ceil((b.east - b.west) / cell);
  const h = Math.ceil((b.north - b.south) / cell);
  const toMerc = projectionLattice('EPSG:27700', merc.crs, b);
  const data = new Float32Array(w * h);
  const xy: [number, number] = [0, 0];
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      toMerc(b.west + (col + 0.5) * cell, b.north - (row + 0.5) * cell, xy);
      data[row * w + col] = gridSampleBicubic(merc, xy[0], xy[1], true);
    }
  }
  const grid: Float32Grid = {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: b.west + cell / 2, originY: b.north - cell / 2, pixelW: cell, pixelH: -cell },
  };
  standIns.set(cell, grid);
  return { ...grid, data: new Float32Array(data) };
}

function sliceMs(project: Project, plates: number, preview: boolean): { ms: number; plates: number } {
  const p = { ...project, params: { ...project.params, plateCount: String(plates) } };
  const top = p.images.top?.depth ? depthToGray(p.images.top.depth) : null;
  const assets: Assets = { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null };
  createFrontPipeline({ preview })(p, assets); // warm-up
  const f = createFrontPipeline({ preview })(p, assets);
  return { ms: Math.round(f.stages.find((s) => s.name === 'Slice plates')?.ms ?? 0), plates: f.sliced.plates.length };
}

const spec = defaultMapSpec({
  title: 'Buttermere',
  bbox: BUTTERMERE_BBOX,
  source: 'ea-dtm',
  exaggeration: 4,
  water: 'raw',
  engrave: { enabled: false, features: [] },
});
const stack = mapStackFromProject(base);
const opts = { stack, eaLoader: async (_s: unknown, sized: { resM?: number; maxSide?: number }) => lidarStandIn(sized), allowOverpassNetwork: false as const };
await buildMapBundle(spec, opts); // warm-up
const t0 = performance.now();
const bundle = await buildMapBundle(spec, opts);
const buildMs = Math.round(performance.now() - t0);
const project: Project = { ...base, images: { ...base.images, top: bundle.asset } };
const depth = bundle.depth;
const cellM = Math.max((depth.mapOrtho?.widthM ?? 0) / depth.w, (depth.mapOrtho?.heightM ?? 0) / depth.h);
const bytes = Buffer.byteLength(serialize(project));
const s77 = sliceMs(project, 77, false);
const s93 = sliceMs(project, 93, false);
const p93 = sliceMs(project, 93, true);
const top = depthToGray(depth);
const { createPipeline } = await import('../src/core/pipeline');
const audit = curveAudit(createPipeline()(project, { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null }));
const out = {
  grid: `${depth.w} × ${depth.h}`,
  cellM: Number(cellM.toFixed(2)),
  buildMs,
  projectMB: Number((bytes / 1e6).toFixed(2)),
  slice77Ms: s77.ms,
  slice93Ms: s93.ms,
  preview93Ms: p93.ms,
  plates: s77.plates,
  plates93: s93.plates,
  medianTurnDeg: Number(audit.medianTurnDeg.toFixed(2)),
  over20Pct: Number((audit.over20Share * 100).toFixed(2)),
  arcPct: Number((audit.arcLengthShare * 100).toFixed(1)),
  fitErrors: audit.fitErrors,
  platesAtTop: audit.platesAtTop,
};
if (json) console.log(JSON.stringify(out));
else for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(14)} ${v}`);
