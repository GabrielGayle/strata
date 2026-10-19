// The cloud terrain job (Boost) against the local build, on Buttermere and Neasden from an
// Environment Agency source: grid, cell size, build time, result size, saved project size and
// slice time at 93 plates.
// npx tsx scripts/bench-cloud-terrain.ts [--cache <dir>] [--json]
// The EA LiDAR service is not reachable from every machine, so the "LiDAR" here is Terrarium
// resampled onto the BNG grid the WCS request would return (same SCALEFACTOR): real terrain,
// real grid sizes and timings, but no 1 m detail and no network time.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { BUTTERMERE_BBOX, NEASDEN_BBOX } from '../test/map-fixtures';
import { runTerrainJob, terrainJobRequest } from '../src/core/cloudTerrain';
import { depthToGray } from '../src/core/depth';
import type { Float32Grid } from '../src/core/mapGrid';
import { gridSampleBicubic } from '../src/core/mapGrid';
import { metricBounds, projectionLattice } from '../src/core/mapProject';
import { defaultMapSpec } from '../src/core/mapSpec';
import { eaWcsScaleFactor } from '../src/core/mapEaWcs';
import { fetchTerrariumGrid, getTileFetcher } from '../src/core/mapTerrarium';
import { cachedTileFetch } from '../src/core/mapCache';
import { createFrontPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, serialize, type Project } from '../src/core/project';

const args = process.argv.slice(2);
const json = args.includes('--json');
const ci = args.indexOf('--cache');
const cacheDir = ci >= 0 ? args[ci + 1] : undefined;
const inner = getTileFetcher();

const base = deserialize(readFileSync('test/fixtures/projects/buttermere-terrarium-77.strata.json', 'utf8'));
base.params = { ...base.params, plateCount: '93' };

/** Terrarium on the EPSG:27700 grid an EA WCS reply would have for this request. */
async function standInLoader(bbox: [number, number, number, number]) {
  const merc = await fetchTerrariumGrid({ bbox }, { fetch: (url) => cachedTileFetch(cacheDir, url, (u) => inner(u)) });
  const made = new Map<number, Float32Grid>();
  return async (_s: unknown, sized: { resM?: number; maxSide?: number }): Promise<Float32Grid> => {
    const cell = 1 / eaWcsScaleFactor(bbox, sized.resM ?? 8, sized.maxSide);
    const hit = made.get(cell);
    if (hit) return { ...hit, data: new Float32Array(hit.data) };
    const b = metricBounds(bbox, 'EPSG:27700');
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
    made.set(cell, grid);
    return { ...grid, data: new Float32Array(data) };
  };
}

function sliceMs(project: Project): { ms: number; plates: number } {
  const top = project.images.top?.depth ? depthToGray(project.images.top.depth) : null;
  const assets: Assets = { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null };
  createFrontPipeline({ preview: false })(project, assets); // warm-up
  const f = createFrontPipeline({ preview: false })(project, assets);
  return { ms: Math.round(f.stages.find((s) => s.name === 'Slice plates')?.ms ?? 0), plates: f.sliced.plates.length };
}

const rows: Record<string, unknown>[] = [];
for (const [title, bbox] of [
  ['Buttermere', BUTTERMERE_BBOX],
  ['Neasden', NEASDEN_BBOX],
] as const) {
  const eaLoader = await standInLoader(bbox);
  const spec = defaultMapSpec({ title, bbox, source: 'ea-dtm', exaggeration: 4, water: 'raw', engrave: { enabled: false, features: [] } });
  for (const maxPx of [1024, 2048] as const) {
    const req = terrainJobRequest(base, spec, maxPx, 'bench');
    const opts = { eaLoader, allowOverpassNetwork: false as const };
    await runTerrainJob(req, opts); // warm-up (and makes the stand-in grid)
    const t0 = performance.now();
    const asset = await runTerrainJob(req, opts);
    const buildMs = Math.round(performance.now() - t0);
    const depth = asset.depth!;
    const cellM = Math.max((depth.mapOrtho?.widthM ?? 0) / depth.w, (depth.mapOrtho?.heightM ?? 0) / depth.h);
    asset.map = { ...asset.map!, cloudBuilt: { key: '0'.repeat(32), px: Math.max(depth.w, depth.h) } };
    const project: Project = { ...base, images: { ...base.images, top: asset } };
    const slice = sliceMs(project);
    rows.push({
      map: title,
      maxPx,
      grid: `${depth.w} × ${depth.h}`,
      cellM: Number(cellM.toFixed(2)),
      buildMs,
      resultMB: Number((gzipSync(JSON.stringify(asset)).length / 1e6).toFixed(2)),
      savedMB: Number((Buffer.byteLength(serialize(project)) / 1e6).toFixed(2)),
      slice93Ms: slice.ms,
      plates: slice.plates,
    });
  }
}
if (json) console.log(JSON.stringify(rows));
else console.table(rows);
