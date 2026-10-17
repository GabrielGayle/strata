import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { applyLayerBudget, computeLayerBreaks } from '../src/core/mapLayerBudget';
import { mapDepthToGray, sampleMapHeightGrid } from '../src/core/mapPlateHeight';
import { buildMapBundle } from '../src/core/mapPipeline';
import { metricBounds, reprojectResample } from '../src/core/mapProject';
import { defaultMapSpec } from '../src/core/mapSpec';
import {
  applyLocalWaterResult,
  pointInWaterBody,
  restoreWaterSurfaces,
  waterBodiesFromOverpass,
  WATER_KIND_LAKE,
  WATER_KIND_STREAM,
  type WaterBody,
} from '../src/core/mapWater';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { simplifyMetricGrid } from '../src/core/mapSimplify';
import type { Float32Grid } from '../src/core/mapGrid';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

const CRUMMOCK_M = 98.67;
const BUTTERMERE_M = 100.72;
const BLEABERRY_M = 493.39;
const LAND_M = 400;

function lonLat(x: number, y: number): { lon: number; lat: number } {
  const [lon, lat] = proj4('EPSG:27700', 'EPSG:4326', [x, y]) as [number, number];
  return { lon, lat };
}

function ring(west: number, south: number, east: number, north: number): { lon: number; lat: number }[] {
  return [
    lonLat(west, south),
    lonLat(east, south),
    lonLat(east, north),
    lonLat(west, north),
    lonLat(west, south),
  ];
}

function line(points: [number, number][]): { lon: number; lat: number }[] {
  return points.map(([x, y]) => lonLat(x, y));
}

interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

function fracBox(
  b: { west: number; south: number; east: number; north: number },
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): Box {
  const w = b.east - b.west;
  const h = b.north - b.south;
  return {
    west: b.west + u0 * w,
    south: b.south + v0 * h,
    east: b.west + u1 * w,
    north: b.south + v1 * h,
  };
}

function inBox(x: number, y: number, box: Box): boolean {
  return x >= box.west && x <= box.east && y >= box.south && y <= box.north;
}

function twoLakeDem(): { grid: Float32Grid; boxes: { crummock: Box; buttermere: Box; bleaberry: Box } } {
  const b = metricBounds(NEASDEN_FAST_BBOX, 'EPSG:27700');
  const w = 64;
  const h = 64;
  const pixelW = (b.east - b.west) / w;
  const pixelH = (b.north - b.south) / h;
  const boxes = {
    crummock: fracBox(b, 0.02, 0.54, 0.4, 0.98),
    buttermere: fracBox(b, 0.48, 0.24, 0.94, 0.72),
    bleaberry: fracBox(b, 0.64, 0.7, 0.98, 0.98),
  };
  const osmBoxes = {
    crummock: fracBox(b, 0.06, 0.6, 0.34, 0.9),
    buttermere: fracBox(b, 0.54, 0.3, 0.88, 0.66),
    bleaberry: fracBox(b, 0.7, 0.76, 0.92, 0.94),
  };
  const data = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const x = b.west + (col + 0.5) * pixelW;
      const y = b.south + (row + 0.5) * pixelH;
      let z = LAND_M + 8 * Math.sin(col / 6) * Math.cos(row / 7);
      if (inBox(x, y, boxes.bleaberry)) z = BLEABERRY_M;
      else if (inBox(x, y, boxes.buttermere)) z = BUTTERMERE_M;
      else if (inBox(x, y, boxes.crummock)) z = col % 9 === 0 ? CRUMMOCK_M - 4 : CRUMMOCK_M;
      data[row * w + col] = z;
    }
  }
  return {
    grid: {
      w,
      h,
      data,
      crs: 'EPSG:27700',
      transform: { originX: b.west + pixelW / 2, originY: b.south + pixelH / 2, pixelW, pixelH },
    },
    boxes: osmBoxes,
  };
}

function osmFor(boxes: { crummock: Box; buttermere: Box; bleaberry: Box }, b: Box) {
  const midY = (b.south + b.north) / 2;
  const midX = (b.west + b.east) / 2;
  return {
    elements: [
      {
        type: 'way',
        tags: { natural: 'water', water: 'lake', name: 'Crummock Water' },
        geometry: ring(boxes.crummock.west, boxes.crummock.south, boxes.crummock.east, boxes.crummock.north),
      },
      {
        type: 'way',
        tags: { natural: 'water', water: 'lake', name: 'Buttermere' },
        geometry: ring(boxes.buttermere.west, boxes.buttermere.south, boxes.buttermere.east, boxes.buttermere.north),
      },
      {
        type: 'way',
        tags: { natural: 'water', water: 'lake', name: 'Bleaberry Tarn' },
        geometry: ring(boxes.bleaberry.west, boxes.bleaberry.south, boxes.bleaberry.east, boxes.bleaberry.north),
      },
      {
        type: 'way',
        tags: { waterway: 'stream', name: 'Dodsgill Beck' },
        geometry: line([
          [b.west + 20, midY],
          [b.east - 20, midY],
        ]),
      },
      {
        type: 'way',
        tags: { waterway: 'stream', name: 'Dry Gill' },
        geometry: line([
          [midX, b.south + 20],
          [midX, b.north - 20],
        ]),
      },
    ],
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function namedLake(bodies: WaterBody[], re: RegExp): WaterBody {
  const hit = bodies.find((b) => b.kind === 'lake' && re.test(b.name ?? ''));
  if (!hit) throw new Error(`missing lake ${re}`);
  return hit;
}

describe('water through layer budget and export plates', () => {
  it('final plate heights keep distinct lakes and never raise water above the DEM', async () => {
    const { grid, boxes } = twoLakeDem();
    const bounds = metricBounds(NEASDEN_FAST_BBOX, 'EPSG:27700');
    const osm = osmFor(boxes, bounds);
    const spec = defaultMapSpec({
      bbox: NEASDEN_FAST_BBOX,
      source: 'ea-dtm',
      water: 'flat',
      exaggeration: 4,
      layerBudget: 'jenks',
      engrave: { enabled: false, features: [] },
      resM: 48,
    });
    const raw = reprojectResample(grid, spec);
    const bundle = await buildMapBundle(spec, {
      eaLoader: async () => grid,
      overpass: async () => osm,
      allowOverpassNetwork: false,
      fetch: async () => {
        throw new Error('water-export test must not mosaic tiles');
      },
      stack: { plateCount: 12, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' },
    });

    const bodies = waterBodiesFromOverpass(osm, spec, bundle.metric.crs);
    const classified = applyLocalWaterResult(raw, bodies);
    const crummock = namedLake(bodies, /crummock/i);
    const buttermere = namedLake(bodies, /buttermere/i);
    const bleaberry = namedLake(bodies, /bleaberry/i);

    const crummockZ: number[] = [];
    const butterZ: number[] = [];
    const bleaberryZ: number[] = [];
    let waterAbove = 0;
    let maxRaise = 0;
    let streamCells = 0;
    for (let i = 0; i < bundle.metric.data.length; i++) {
      const z = bundle.metric.data[i];
      const rawZ = raw.data[i];
      if (!Number.isFinite(z) || !Number.isFinite(rawZ)) continue;
      if (classified.waterKind[i]) {
        if (z > rawZ + 1e-3) {
          waterAbove++;
          maxRaise = Math.max(maxRaise, z - rawZ);
        }
      }
      if (classified.waterKind[i] === WATER_KIND_STREAM) streamCells++;
    }
    for (let row = 0; row < bundle.metric.h; row++) {
      for (let col = 0; col < bundle.metric.w; col++) {
        const i = row * bundle.metric.w + col;
        const x = bundle.metric.transform.originX + col * bundle.metric.transform.pixelW;
        const y = bundle.metric.transform.originY + row * bundle.metric.transform.pixelH;
        const z = bundle.metric.data[i];
        if (!Number.isFinite(z)) continue;
        if (pointInWaterBody([x, y], crummock)) crummockZ.push(z);
        if (pointInWaterBody([x, y], buttermere)) butterZ.push(z);
        if (pointInWaterBody([x, y], bleaberry)) bleaberryZ.push(z);
      }
    }
    expect(waterAbove, `water raised above DEM by up to ${maxRaise.toFixed(2)} m`).toBe(0);
    expect(crummockZ.length).toBeGreaterThan(8);
    expect(butterZ.length).toBeGreaterThan(8);
    expect(bleaberryZ.length).toBeGreaterThan(4);
    expect(median(crummockZ)).toBeCloseTo(CRUMMOCK_M, 0);
    expect(median(butterZ)).toBeCloseTo(BUTTERMERE_M, 0);
    expect(median(bleaberryZ)).toBeCloseTo(BLEABERRY_M, 0);
    expect(Math.abs(median(crummockZ) - median(butterZ))).toBeGreaterThan(1);
    expect(bundle.asset.map?.layerBreaksM?.some((p) => Math.abs(p - CRUMMOCK_M) < 0.05)).toBe(true);
    expect(bundle.asset.map?.layerBreaksM?.some((p) => Math.abs(p - BUTTERMERE_M) < 0.05)).toBe(true);
    expect(streamCells).toBeGreaterThan(4);

    const p = newProject();
    p.params = { ...p.params, plateCount: '12', thickness: '3', baseLength: '520', baseWidth: '380', insShape: 'none', topDepth: '40' };
    p.images.top = bundle.asset;
    const gray = mapDepthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.hf).toBeTruthy();
    const plates = sampleMapHeightGrid(m.hf!, m.v, bundle.metric.w, bundle.metric.h);
    const crummockH: number[] = [];
    const butterH: number[] = [];
    const bleaberryH: number[] = [];
    for (let row = 0; row < bundle.metric.h; row++) {
      for (let col = 0; col < bundle.metric.w; col++) {
        const i = row * bundle.metric.w + col;
        const x = bundle.metric.transform.originX + col * bundle.metric.transform.pixelW;
        const y = bundle.metric.transform.originY + row * bundle.metric.transform.pixelH;
        const hMm = plates[i];
        if (!Number.isFinite(hMm)) continue;
        if (pointInWaterBody([x, y], crummock)) crummockH.push(hMm);
        if (pointInWaterBody([x, y], buttermere)) butterH.push(hMm);
        if (pointInWaterBody([x, y], bleaberry)) bleaberryH.push(hMm);
      }
    }
    expect(median(butterH)).toBeGreaterThan(median(crummockH) + 0.4);
    expect(median(bleaberryH)).toBeGreaterThan(median(butterH) + 4);
  });

  it('restore after snap keeps each lake on its own level', () => {
    const w = 24;
    const h = 12;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = i < w * 6 ? CRUMMOCK_M : BUTTERMERE_M;
    const grid: Float32Grid = {
      w,
      h,
      data,
      crs: 'EPSG:27700',
      transform: { originX: 0, originY: 120, pixelW: 10, pixelH: -10 },
    };
    const crummock: WaterBody = {
      kind: 'lake',
      path: [
        [0, 60],
        [240, 60],
        [240, 120],
        [0, 120],
        [0, 60],
      ],
      bbox: { west: 0, south: 60, east: 240, north: 120 },
      name: 'Crummock Water',
    };
    const buttermere: WaterBody = {
      kind: 'lake',
      path: [
        [0, 0],
        [240, 0],
        [240, 60],
        [0, 60],
        [0, 0],
      ],
      bbox: { west: 0, south: 0, east: 240, north: 60 },
      name: 'Buttermere',
    };
    const water = applyLocalWaterResult(grid, [crummock, buttermere]);
    const budget = computeLayerBreaks(water.grid, 6, 'jenks', water.lakeSurfacesM);
    const snapped = applyLayerBudget(water.grid, budget.breaksM, { floorMask: water.waterKind, cap: grid.data });
    const simplified = simplifyMetricGrid(snapped, { kerfMm: 0.2, pixelSizeM: 10 });
    const final = restoreWaterSurfaces(simplified.grid, grid, water);
    const top = final.data[1 * w + 4];
    const bottom = final.data[10 * w + 4];
    expect(Math.abs(top - bottom)).toBeGreaterThan(1);
    expect(Math.min(top, bottom)).toBeCloseTo(CRUMMOCK_M, 1);
    expect(Math.max(top, bottom)).toBeCloseTo(BUTTERMERE_M, 1);
    for (let i = 0; i < final.data.length; i++) {
      expect(final.data[i]).toBeLessThanOrEqual(grid.data[i] + 1e-6);
    }
    expect(water.waterKind[2 * w + 4]).toBe(WATER_KIND_LAKE);
    expect(water.waterKind[10 * w + 4]).toBe(WATER_KIND_LAKE);
  });
});
