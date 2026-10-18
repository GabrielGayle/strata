// Map correctness (engine plan PR 1): no terraces on upright stacks, a build key
// that follows the plate stack, one pixel convention, and an orientation check
// that reads plate geometry in world space without reusing hf.at.
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { mapBuildKey, mapTerrainIsCurrent } from '../src/core/mapBuildKey';
import { gridSampleBilinear, type Float32Grid } from '../src/core/mapGrid';
import { buildMapBundle } from '../src/core/mapPipeline';
import { buildMapHeightField, mapDepthToGray, mapGridUvToWorld } from '../src/core/mapPlateHeight';
import { metricBounds, pickMetricCrs, reprojectResample } from '../src/core/mapProject';
import { defaultMapSpec, type MapSpec } from '../src/core/mapSpec';
import { MAP_WIDTH_AXIS_NOTE, mapFaceParams, mapStackFromProject, type MapStackContext } from '../src/core/mapStack';
import { mapGridToDepth } from '../src/core/mapToDepth';
import { evaluateParams } from '../src/core/params';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import type { Part } from '../src/core/slicer';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

type Bbox = [number, number, number, number];

/** A smooth ramp with a hill: lots of distinct heights, so terraces are easy to count. */
function rampGrid(bbox: Bbox, size = 48): Float32Grid {
  const crs = pickMetricCrs(bbox);
  const b = metricBounds(bbox, crs);
  const pixelW = (b.east - b.west) / size;
  const absH = (b.north - b.south) / size;
  const data = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const u = col / (size - 1);
      const v = row / (size - 1);
      data[row * size + col] = 20 + 30 * u + 25 * Math.exp(-((u - 0.6) ** 2 + (v - 0.4) ** 2) / 0.05);
    }
  }
  return { w: size, h: size, data, crs, transform: { originX: b.west + pixelW / 2, originY: b.north - absH / 2, pixelW, pixelH: -absH } };
}

function distinctLevels(g: Float32Grid): number {
  const s = new Set<number>();
  for (const z of g.data) if (Number.isFinite(z)) s.add(Math.round(z * 1000));
  return s.size;
}

const stack = (sliceMode: string, plateCount = 12): MapStackContext => ({
  plateCount,
  thicknessMm: 3,
  masterWidthMm: 520,
  layerBudget: 'jenks',
  kerfMm: 0.2,
  sliceMode,
});

async function build(spec: Partial<MapSpec>, s: MapStackContext) {
  const grid = rampGrid(NEASDEN_FAST_BBOX);
  return buildMapBundle(
    defaultMapSpec({
      bbox: NEASDEN_FAST_BBOX,
      source: 'ea-dtm',
      water: 'raw',
      exaggeration: 4,
      resM: 20,
      engrave: { enabled: false, features: [] },
      ...spec,
    }),
    { eaLoader: async () => grid, allowOverpassNetwork: false, stack: s },
  );
}

describe('layer budget only snaps flat stacks', () => {
  it('upright stacks keep continuous heights; flat stacks and Terraced layers snap', async () => {
    const upright = await build({}, stack('parallel'));
    const flat = await build({}, stack('flat'));
    const terraced = await build({ terraced: true }, stack('parallel'));
    // the snapped grid holds about one level per plate (plus kept summit cells and blur at the edges of a step)
    expect(distinctLevels(upright.metric)).toBeGreaterThan(200);
    expect(distinctLevels(flat.metric)).toBeLessThan(distinctLevels(upright.metric) / 2);
    expect(distinctLevels(terraced.metric)).toBe(distinctLevels(flat.metric));
    // the breaks are still computed for the readout and contours
    expect(upright.asset.map?.layerBreaksM?.length).toBeGreaterThan(0);
  });

  it('keeps the true summit on an upright stack', async () => {
    const upright = await build({}, stack('parallel'));
    const src = rampGrid(NEASDEN_FAST_BBOX);
    const raw = reprojectResample(src, { bbox: NEASDEN_FAST_BBOX, resM: 20 });
    const max = (g: Float32Grid) => Math.max(...Array.from(g.data).filter(Number.isFinite));
    expect(max(upright.metric)).toBeCloseTo(max(raw), 3);
  });
});

describe('map build key follows the plate stack', () => {
  const spec = defaultMapSpec({ bbox: NEASDEN_FAST_BBOX });
  const base = { ...stack('parallel'), baseLengthMm: 520, baseWidthMm: 380 };
  const key = mapBuildKey(spec, base);

  it.each([
    ['plateCount', { plateCount: 13 }],
    ['thickness', { thicknessMm: 1.5 }],
    ['base length', { baseLengthMm: 600 }],
    ['base width', { baseWidthMm: 300 }],
    ['kerf', { kerfMm: 0.3 }],
    ['slicing', { sliceMode: 'flat' }],
  ] as const)('%s change makes the terrain stale', (_label, patch) => {
    expect(mapBuildKey(spec, { ...base, ...patch })).not.toBe(key);
    expect(mapTerrainIsCurrent({ ...spec, buildKey: key }, {}, { ...base, ...patch })).toBe(false);
  });

  it('Terraced layers is part of the key', () => {
    expect(mapBuildKey({ ...spec, terraced: true }, base)).not.toBe(key);
  });

  it('reads the stack from project params', () => {
    const p = newProject();
    p.params = { ...p.params, plateCount: '30', thickness: '2', baseLength: '700', baseWidth: '310', kerf: '0.25', sliceMode: 'flat' };
    expect(mapStackFromProject(p)).toMatchObject({ plateCount: 30, thicknessMm: 2, baseLengthMm: 700, baseWidthMm: 310, kerfMm: 0.25, sliceMode: 'flat' });
  });

  it('builds store the key they were built for', async () => {
    const s = { ...stack('parallel'), baseLengthMm: 520, baseWidthMm: 380 };
    const b = await build({}, s);
    expect(b.asset.map!.buildKey).toBe(mapBuildKey(b.asset.map!, s));
  });
});

describe('pixel conventions', () => {
  it('gridSampleBilinear reads a cell at its centre', () => {
    const g: Float32Grid = {
      w: 4,
      h: 3,
      data: Float32Array.from({ length: 12 }, (_, i) => i),
      crs: 'EPSG:27700',
      transform: { originX: 105, originY: 295, pixelW: 10, pixelH: -10 },
    };
    // cell (col 2, row 1) centre = (125, 285)
    expect(gridSampleBilinear(g, 125, 285)).toBeCloseTo(6, 6);
    expect(gridSampleBilinear(g, 105, 295)).toBeCloseTo(0, 6);
    // half way between two centres
    expect(gridSampleBilinear(g, 130, 285)).toBeCloseTo(6.5, 6);
  });

  it('resampling a grid onto itself is the identity', () => {
    const bbox = NEASDEN_FAST_BBOX;
    const crs = pickMetricCrs(bbox);
    const b = metricBounds(bbox, crs);
    // let the resampler pick its size, then build a source with exactly those cells
    const size = reprojectResample(rampGrid(bbox), { bbox, resM: 8 });
    const { w, h } = size;
    const pixelW = (b.east - b.west) / w;
    const absH = (b.north - b.south) / h;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = (i % w) * 3 + Math.floor(i / w);
    const src: Float32Grid = { w, h, data, crs, transform: { originX: b.west + pixelW / 2, originY: b.north - absH / 2, pixelW, pixelH: -absH } };
    const out = reprojectResample(src, { bbox, resM: 8 });
    expect(out.w).toBe(w);
    expect(out.h).toBe(h);
    let worst = 0;
    for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(out.data[i] - data[i]));
    expect(worst).toBeLessThan(1e-3);
  });

  it('plate heights and OSM engrave art put a cell in the same place', () => {
    // one tall cell; engrave art maps pixel i to [i, i + 1], so its centre is (i + 0.5) / w
    const w = 20;
    const h = 10;
    const data = new Float32Array(w * h).fill(10);
    const col = 13;
    const row = 3;
    data[row * w + col] = 60;
    const grid: Float32Grid = { w, h, data, crs: 'EPSG:27700', transform: { originX: 5, originY: 95, pixelW: 10, pixelH: -10 } };
    const { depth } = mapGridToDepth(grid, { exaggeration: 1 });
    const v = evaluateParams({ ...newProject().params, baseLength: '200', baseWidth: '400', sliceMode: 'parallel', sliceAxis: 'length' }).values;
    const hf = buildMapHeightField(v, depth);
    const centre = mapGridUvToWorld(v, (col + 0.5) / w, (row + 0.5) / h);
    const peak = hf.at(centre.x, centre.z);
    expect(peak).toBeCloseTo(hf.max, 3);
    // a neighbouring centre is ground level
    const next = mapGridUvToWorld(v, (col + 1.5) / w, (row + 0.5) / h);
    expect(hf.at(next.x, next.z)).toBeCloseTo(hf.min, 3);
  });
});

/** North-up source grid with one conical hill in a corner (row 0 north, col 0 west), in `crs`. */
type Corner = 'ne' | 'nw' | 'se' | 'sw';

function cornerHill(bbox: Bbox, corner: Corner, crs: string, size = 64): Float32Grid {
  const ll = (lon: number, lat: number) => (crs === 'EPSG:4326' ? [lon, lat] : (proj4('EPSG:4326', crs, [lon, lat]) as [number, number]));
  const [west, south, east, north] = bbox;
  const [x0, y1] = ll(west - (east - west) * 0.05, north + (north - south) * 0.05);
  const [x1, y0] = ll(east + (east - west) * 0.05, south - (north - south) * 0.05);
  const pixelW = (x1 - x0) / size;
  const absH = (y1 - y0) / size;
  const data = new Float32Array(size * size);
  const fe = corner[1] === 'e' ? 0.8 : 0.2;
  const fn = corner[0] === 'n' ? 0.8 : 0.2;
  const [cLon, cLat] = [west + fe * (east - west), south + fn * (north - south)];
  const [cx, cy] = ll(cLon, cLat);
  const r = 0.12 * (x1 - x0);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = x0 + (col + 0.5) * pixelW;
      const y = y1 - (row + 0.5) * absH;
      // a cone, so the summit is one point and the highest vertex is unambiguous
      data[row * size + col] = 20 + 100 * Math.max(0, 1 - Math.hypot(x - cx, y - cy) / r);
    }
  }
  return { w: size, h: size, data, crs, transform: { originX: x0 + pixelW / 2, originY: y1 - absH / 2, pixelW, pixelH: -absH } };
}

/** World (x, z) of the highest outline vertex over all main plates, read from each part's plane. */
function highestWorldPoint(parts: Part[]): { x: number; y: number; z: number } {
  let best = { x: 0, y: -Infinity, z: 0 };
  for (const part of parts) {
    if (part.family !== 'P') continue;
    const { origin, u, v } = part.plane;
    for (const poly of part.shape) {
      for (const [a, b] of poly.outer) {
        const p = { x: origin[0] + a * u[0] + b * v[0], y: origin[1] + a * u[1] + b * v[1], z: origin[2] + a * u[2] + b * v[2] };
        if (p.y > best.y) best = p;
      }
    }
  }
  return best;
}

function slicedMap(source: Float32Grid, bbox: Bbox, sliceAxis: 'length' | 'width') {
  const metric = reprojectResample(source, { bbox, resM: 16, model: 'dtm' });
  const { depth } = mapGridToDepth(metric, { exaggeration: 3, bbox });
  const p = newProject();
  p.params = {
    ...p.params,
    sliceMode: 'parallel',
    sliceAxis,
    baseLength: '420',
    baseWidth: '300',
    plateCount: '24',
    thickness: '3',
    erosionAmp: '0',
    crest: '0',
    slope: '0',
    insShape: 'none',
    imgTopMode: 'carve',
  };
  p.images.top = { name: 'Map', dataUrl: 'data:image/png;base64,xx', map: defaultMapSpec({ bbox }), depth };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: mapDepthToGray(depth), insMesh: null, srcMesh: null });
}

// World frame (AGENTS.md): +X south, +Z west, so north is −X and east is −Z.
const BNG_BBOX: Bbox = [-0.27, 51.55, -0.25, 51.562];
const UTM_BBOX: Bbox = [7.0, 45.9, 7.026, 45.916];

describe('map orientation, independent of hf.at', () => {
  it.each([
    ['BNG grid', BNG_BBOX, 'EPSG:27700'],
    ['UTM from Web Mercator', UTM_BBOX, 'EPSG:3857'],
  ] as const)('%s: a hill in each corner lands in that corner for both slice axes', (_label, bbox, crs) => {
    // off-diagonal corners matter: a transposed frame keeps NE and SW in place but swaps NW and SE
    for (const axis of ['length', 'width'] as const) {
      for (const corner of ['ne', 'nw', 'se', 'sw'] as const) {
        const top = highestWorldPoint(slicedMap(cornerHill(bbox, corner, crs), bbox, axis).sliced.parts);
        const where = `${axis}, ${corner} hill`;
        if (corner[0] === 'n') expect(top.x, `${where}: north is −X`).toBeLessThan(0);
        else expect(top.x, `${where}: south is +X`).toBeGreaterThan(0);
        if (corner[1] === 'e') expect(top.z, `${where}: east is −Z`).toBeLessThan(0);
        else expect(top.z, `${where}: west is +Z`).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('stacking along the width on a map face is evaluated as length, with a notice', () => {
    const src = cornerHill(BNG_BBOX, 'ne', 'EPSG:27700');
    const len = slicedMap(src, BNG_BBOX, 'length');
    const wid = slicedMap(src, BNG_BBOX, 'width');
    expect(wid.v.sliceAxis).toBe('length');
    expect(wid.sliced.plates.length).toBe(len.sliced.plates.length);
    expect(wid.sliced.warnings).toContain(MAP_WIDTH_AXIS_NOTE);
    expect(len.sliced.warnings).not.toContain(MAP_WIDTH_AXIS_NOTE);
  });

  it('picks the UTM zone the bbox is in', () => {
    expect(pickMetricCrs([7.0, 45.9, 7.026, 45.916])).toBe('EPSG:32632');
    expect(pickMetricCrs([-74.02, 40.7, -73.99, 40.72])).toBe('EPSG:32618');
    expect(pickMetricCrs([151.2, -33.87, 151.22, -33.85])).toBe('EPSG:32756');
  });

  it('leaves non-map params alone', () => {
    const raw = { sliceAxis: 'width', sliceMode: 'parallel' };
    expect(mapFaceParams(raw).raw.sliceAxis).toBe('length');
    expect(mapFaceParams({ ...raw, sliceAxis: 'length' }).forced).toBe(false);
  });
});

describe('decoded depth cache', () => {
  it('two maps with the same size, range and edges do not share a decode', () => {
    const a = slicedMap(cornerHill(UTM_BBOX, 'ne', 'EPSG:3857'), UTM_BBOX, 'length');
    const b = slicedMap(cornerHill(UTM_BBOX, 'nw', 'EPSG:3857'), UTM_BBOX, 'length');
    const pa = highestWorldPoint(a.sliced.parts);
    const pb = highestWorldPoint(b.sliced.parts);
    expect(Math.sign(pa.z)).not.toBe(Math.sign(pb.z));
  });
});
