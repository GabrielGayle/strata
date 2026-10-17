import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { evaluateParams } from '../src/core/params';
import { fetchEaLidarGrid } from '../src/core/mapEaLidar';
import { gridRow0IsNorth } from '../src/core/mapGrid';
import { osmToEngraveArt } from '../src/core/mapOsmEngrave';
import { metricBounds, pickMetricCrs, reprojectResample } from '../src/core/mapProject';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapGridToDepth } from '../src/core/mapToDepth';
import { mapEngravePathsForPart } from '../src/core/mapEngravePlate';
import {
  buildMapHeightField,
  mapDepthToGray,
  mapTopProject,
  sampleMapHeightGrid,
} from '../src/core/mapPlateHeight';
import type { Float32Grid } from '../src/core/mapGrid';
import type { Part } from '../src/core/slicer';
import { BUTTERMERE_BBOX } from './map-fixtures';

const live = process.env.LIVE_MAP === '1';

const SYNTH_BBOX: [number, number, number, number] = [-0.255, 51.548, -0.245, 51.556];

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const xs: number[] = [];
  const ys: number[] = [];
  const n0 = Math.min(a.length, b.length);
  for (let i = 0; i < n0; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  const n = xs.length;
  if (n < 8) return NaN;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const cov = n * sxy - sx * sy;
  const d = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return d < 1e-12 ? 0 : cov / d;
}

function flipRows(data: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let r = 0; r < h; r++) out.set(data.subarray(r * w, (r + 1) * w), (h - 1 - r) * w);
  return out;
}

function argMax(data: Float32Array): number {
  let i = 0;
  for (let k = 1; k < data.length; k++) if (data[k] > data[i]) i = k;
  return i;
}

/** North-up DEM: high in the north-west corner, low in the south-east. */
function nwHighSource(bbox: [number, number, number, number], size = 64): Float32Grid {
  const crs = pickMetricCrs(bbox);
  const b = metricBounds(bbox, crs);
  const w = size;
  const h = size;
  const pixelW = (b.east - b.west) / w;
  const absH = (b.north - b.south) / h;
  const data = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const north = 1 - row / Math.max(1, h - 1);
      const west = 1 - col / Math.max(1, w - 1);
      data[row * w + col] = 40 + 90 * north * west;
    }
  }
  return {
    w,
    h,
    data,
    crs,
    transform: {
      originX: b.west + pixelW / 2,
      originY: b.north - absH / 2,
      pixelW,
      pixelH: -absH,
    },
  };
}

function meanPathY(path: [number, number][]): number {
  return path.reduce((s, p) => s + p[1], 0) / path.length;
}

function meanPathX(path: [number, number][]): number {
  return path.reduce((s, p) => s + p[0], 0) / path.length;
}

/** North-up DEM: a single high blob in the north-east corner. */
function neHighSource(bbox: [number, number, number, number], size = 64): Float32Grid {
  const src = nwHighSource(bbox, size);
  for (let row = 0; row < src.h; row++) {
    for (let col = 0; col < src.w; col++) {
      const nr = src.h <= 1 ? 0 : row / (src.h - 1);
      const nc = src.w <= 1 ? 0 : col / (src.w - 1);
      const d = Math.hypot(nr - 0.08, nc - 0.92);
      src.data[row * src.w + col] = d < 0.14 ? 140 : 25;
    }
  }
  return src;
}

/** North-up DEM: a single high blob in the south-east corner (last-plate / S-nn face). */
function seHighSource(bbox: [number, number, number, number], size = 64): Float32Grid {
  const src = nwHighSource(bbox, size);
  for (let row = 0; row < src.h; row++) {
    for (let col = 0; col < src.w; col++) {
      const nr = src.h <= 1 ? 0 : row / (src.h - 1);
      const nc = src.w <= 1 ? 0 : col / (src.w - 1);
      const d = Math.hypot(nr - 0.92, nc - 0.92);
      src.data[row * src.w + col] = d < 0.14 ? 140 : 25;
    }
  }
  return src;
}

function peakX(part: Part): number {
  let bestX = (part.bbox.minX + part.bbox.maxX) / 2;
  let bestY = -Infinity;
  for (const poly of part.shape) {
    for (const [x, y] of poly.outer) {
      if (y > bestY) {
        bestY = y;
        bestX = x;
      }
    }
  }
  return bestX;
}

function mapProjectFromGrid(source: Float32Grid, bbox: [number, number, number, number], title: string) {
  const metric = reprojectResample(source, { bbox, resM: 12, model: 'dtm' });
  const { depth } = mapGridToDepth(metric, { exaggeration: 4, bbox });
  const p = newProject();
  p.params = {
    ...p.params,
    baseLength: '400',
    baseWidth: '400',
    plateCount: '12',
    thickness: '3',
    stackHeight: '120',
    erosionAmp: '0',
    crest: '0',
    slope: '0',
    insShape: 'none',
    imgTopMode: 'carve',
  };
  p.images.top = {
    name: 'Map',
    dataUrl: 'data:image/png;base64,xx',
    map: defaultMapSpec({ bbox, title }),
    depth,
  };
  return { metric, depth, p };
}

describe('map north-up orientation', () => {
  it('reproject, 3D far/S-01, and OSM all put north at row 0', () => {
    const source = nwHighSource(SYNTH_BBOX);
    const metric = reprojectResample(source, { bbox: SYNTH_BBOX, resM: 12, model: 'dtm' });
    expect(gridRow0IsNorth(metric)).toBe(true);
    expect(metric.transform.pixelH).toBeLessThan(0);

    const maxI = argMax(metric.data);
    const maxRow = Math.floor(maxI / metric.w);
    const maxCol = maxI % metric.w;
    expect(maxRow, 'peak stays in the north (low rows)').toBeLessThan(metric.h * 0.2);
    expect(maxCol, 'peak stays in the west (low cols)').toBeLessThan(metric.w * 0.2);

    const { depth } = mapGridToDepth(metric, { exaggeration: 4, bbox: SYNTH_BBOX });
    const p = newProject();
    p.params = {
      ...p.params,
      baseLength: '400',
      baseWidth: '400',
      plateCount: '12',
      thickness: '3',
      stackHeight: '120',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
      insShape: 'none',
      imgTopMode: 'carve',
    };
    p.images.top = {
      name: 'Map',
      dataUrl: 'data:image/png;base64,xx',
      map: defaultMapSpec({ bbox: SYNTH_BBOX, title: 'NW high' }),
      depth,
    };
    const gray = mapDepthToGray(depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.hf).toBeTruthy();

    const heights = sampleMapHeightGrid(m.hf!, m.v, metric.w, metric.h);
    const right = pearson(heights, metric.data);
    const flipped = pearson(flipRows(heights, metric.w, metric.h), metric.data);
    expect(right).toBeGreaterThan(0.9);
    expect(right).toBeGreaterThan(flipped + 0.3);

    const northEnd = heights[Math.floor(metric.w * 0.1)];
    const southEnd = heights[(metric.h - 1) * metric.w + Math.floor(metric.w * 0.1)];
    expect(northEnd).toBeGreaterThan(southEnd);

    const plates = m.sliced.parts.filter((q) => q.family === 'P').sort((a, b) => a.index - b.index);
    expect(plates[0].id).toMatch(/^S-01/);
    expect(plates[0].index).toBe(0);
    const s01Top = Math.max(...plates.filter((q) => q.index === 0).map((q) => q.bbox.maxY));
    const lastIdx = plates[plates.length - 1].index;
    const southTop = Math.max(...plates.filter((q) => q.index === lastIdx).map((q) => q.bbox.maxY));
    expect(s01Top).toBeGreaterThan(southTop);

    const v = evaluateParams(p.params).values;
    const hf = buildMapHeightField(v, depth);
    const L = Number(v.baseLength) || 400;
    const W = Number(v.baseWidth) || 400;
    const fFront = hf.at((-0.5) * L * 0.98, 0);
    const fBack = hf.at((0.5) * L * 0.98, 0);
    expect(fFront).toBeGreaterThan(fBack);
    const north = -0.45 * L;
    const westZ = 0.45 * W;
    const eastZ = -0.45 * W;
    expect(hf.at(north, westZ), 'NW-high DEM: west (+Z) is higher than east (−Z)').toBeGreaterThan(hf.at(north, eastZ));
    const nwTop = mapTopProject(north, westZ);
    expect(nwTop.up).toBeGreaterThan(0);
    expect(nwTop.right).toBeLessThan(0);

    const osm = {
      elements: [
        {
          type: 'way',
          tags: { highway: 'track', name: 'North Edge' },
          geometry: [
            { lon: SYNTH_BBOX[0] + 0.001, lat: SYNTH_BBOX[3] - 0.00015 },
            { lon: SYNTH_BBOX[2] - 0.001, lat: SYNTH_BBOX[3] - 0.00015 },
          ],
        },
        {
          type: 'way',
          tags: { highway: 'track', name: 'South Edge' },
          geometry: [
            { lon: SYNTH_BBOX[0] + 0.001, lat: SYNTH_BBOX[1] + 0.00015 },
            { lon: SYNTH_BBOX[2] - 0.001, lat: SYNTH_BBOX[1] + 0.00015 },
          ],
        },
      ],
    };
    const art = osmToEngraveArt(osm, SYNTH_BBOX, depth.w, depth.h, ['roads']);
    expect(art.lines.length).toBeGreaterThanOrEqual(2);
    const ys = art.lines.map((l) => meanPathY(l.path));
    expect(Math.min(...ys) / art.imageH).toBeLessThan(0.12);
    expect(Math.max(...ys) / art.imageH).toBeGreaterThan(0.88);
  });

  it('NE feature lands north (−X) and east (−Z) and top-right in 3D Top', () => {
    const source = neHighSource(SYNTH_BBOX);
    const { metric, depth, p } = mapProjectFromGrid(source, SYNTH_BBOX, 'NE high');
    const maxI = argMax(metric.data);
    expect(Math.floor(maxI / metric.w), 'blob stays in the north').toBeLessThan(metric.h * 0.25);
    expect(maxI % metric.w, 'blob stays in the east').toBeGreaterThan(metric.w * 0.75);

    const gray = mapDepthToGray(depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    const v = m.v;
    const L = v.baseLength;
    const W = v.baseWidth;
    const hf = m.hf!;
    const north = -0.45 * L;
    const south = 0.45 * L;
    const westZ = 0.45 * W;
    const eastZ = -0.45 * W;
    const ne = hf.at(north, eastZ);
    expect(ne).toBeGreaterThan(hf.at(north, westZ));
    expect(ne).toBeGreaterThan(hf.at(south, eastZ));
    expect(ne).toBeGreaterThan(hf.at(south, westZ));

    const top = mapTopProject(north, eastZ);
    expect(top.up, 'north is toward the top of 3D Top').toBeGreaterThan(0);
    expect(top.right, 'east is toward the right of 3D Top').toBeGreaterThan(0);

    const plates = m.sliced.parts.filter((q) => q.family === 'P');
    const s01 = plates.filter((q) => q.index === 0).sort((a, b) => b.bbox.maxY - a.bbox.maxY)[0];
    const xPeak = peakX(s01);
    const mid = (s01.bbox.minX + s01.bbox.maxX) / 2;
    expect(xPeak, 'S-01 viewed from the north has east (the peak) on the left').toBeLessThan(mid);
  });

  it('an easting on the last plate lines up with that plate’s profile', () => {
    const source = seHighSource(SYNTH_BBOX);
    const { depth, p } = mapProjectFromGrid(source, SYNTH_BBOX, 'SE high');
    const gray = mapDepthToGray(depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    const plates = m.sliced.parts.filter((q) => q.family === 'P');
    const lastIdx = Math.max(...plates.map((q) => q.index));
    const south = plates.filter((q) => q.index === lastIdx).sort((a, b) => b.bbox.maxY - a.bbox.maxY)[0];
    const xPeak = peakX(south);
    const mid = (south.bbox.minX + south.bbox.maxX) / 2;
    expect(xPeak, 'SE peak sits at the east / left of the south plate').toBeLessThan(mid);

    const eastLon = SYNTH_BBOX[0] + 0.92 * (SYNTH_BBOX[2] - SYNTH_BBOX[0]);
    const art = osmToEngraveArt(
      {
        elements: [
          {
            type: 'way',
            tags: { waterway: 'stream', name: 'East Beck' },
            geometry: [
              { lon: eastLon, lat: SYNTH_BBOX[1] + 0.0002 },
              { lon: eastLon, lat: SYNTH_BBOX[3] - 0.0002 },
            ],
          },
        ],
      },
      SYNTH_BBOX,
      depth.w,
      depth.h,
      ['water'],
    );
    expect(art.lines.length).toBeGreaterThanOrEqual(1);
    const paths = mapEngravePathsForPart(south, art, {
      faceW: south.bbox.maxX - south.bbox.minX,
      faceH: south.bbox.maxY - south.bbox.minY,
    });
    expect(paths.length).toBeGreaterThan(0);
    const engX = paths.reduce((s, path) => s + meanPathX(path), 0) / paths.length;
    const span = south.bbox.maxX - south.bbox.minX;
    expect(Math.abs(engX - xPeak), 'engraved easting sits on the matching profile point').toBeLessThan(span * 0.2);
  });
});

describe.skipIf(!live)('live EA Buttermere orientation (LIVE_MAP=1)', () => {
  it('3D height grid matches EA north-up (≥0.9) and not the south-up flip', async () => {
    const elev = await fetchEaLidarGrid('ea-dtm', { bbox: BUTTERMERE_BBOX, resM: 16 });
    expect(elev).toBeTruthy();
    const metric = reprojectResample(elev!, { bbox: BUTTERMERE_BBOX, resM: 16, model: 'dtm' });
    expect(gridRow0IsNorth(metric)).toBe(true);

    const maxI = argMax(metric.data);
    const maxRow = Math.floor(maxI / metric.w);
    const maxCol = maxI % metric.w;
    // Grasmoor (~851 m) sits in the north-east of this bbox.
    expect(maxRow, 'Grasmoor must land in the north half (row 0 = north)').toBeLessThan(metric.h * 0.45);
    expect(maxCol, 'Grasmoor must land in the east half').toBeGreaterThan(metric.w * 0.4);

    const { depth } = mapGridToDepth(metric, { exaggeration: 1, bbox: BUTTERMERE_BBOX });
    const v = evaluateParams({
      baseLength: '500',
      baseWidth: '500',
      plateCount: '24',
      thickness: '1.5',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
    }).values;
    const hf = buildMapHeightField(v, depth);
    const heights = sampleMapHeightGrid(hf, v, metric.w, metric.h);
    const right = pearson(heights, metric.data);
    const flipped = pearson(flipRows(heights, metric.w, metric.h), metric.data);
    expect(right).toBeGreaterThanOrEqual(0.9);
    expect(flipped).toBeLessThan(0.55);
    expect(right - flipped).toBeGreaterThan(0.35);
  }, 180_000);
});
