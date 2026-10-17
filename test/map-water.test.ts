import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyFlatWater,
  applyLocalWater,
  estimateBodySurfaceM,
  estimateWaterSurfaceM,
  pointInWaterBody,
  STREAM_INSET_M,
  waterBodiesFromOverpass,
  waterRingsFromOverpass,
  type WaterBody,
} from '../src/core/mapWater';
import { syntheticConeGrid } from '../src/core/mapToDepth';
import { fetchEaLidarGrid } from '../src/core/mapEaLidar';
import { reprojectResample } from '../src/core/mapProject';
import { fetchOverpass } from '../src/core/mapOverpass';
import type { Float32Grid } from '../src/core/mapGrid';
import { pointInPath, type Path } from '../src/core/geom2d';
import { BUTTERMERE_BBOX, BUTTERMERE_LAKE_M, NEASDEN_FAST_BBOX } from './map-fixtures';

const live = process.env.LIVE_MAP === '1';

function rect(west: number, south: number, east: number, north: number): Path {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function plateauGrid(): Float32Grid {
  const w = 80;
  const h = 80;
  const pixel = 10;
  const data = new Float32Array(w * h);
  const originX = 0;
  const originY = h * pixel;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const x = originX + col * pixel;
      const y = originY + row * -pixel;
      let z = 400;
      if (x >= 50 && x <= 200 && y >= 550 && y <= 700) z = 101;
      if (x >= 500 && x <= 700 && y >= 80 && y <= 220) z = 98;
      if (Math.abs(y - 400) < 8) z = 140 + 12 * Math.sin(x / 40);
      data[row * w + col] = z;
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: originX, originY: originY, pixelW: pixel, pixelH: -pixel },
  };
}

const NW_LAKE: WaterBody = {
  kind: 'lake',
  path: rect(50, 550, 200, 700),
  bbox: { west: 50, south: 550, east: 200, north: 700 },
  name: 'North lake',
};

const SE_LAKE: WaterBody = {
  kind: 'lake',
  path: rect(500, 80, 700, 220),
  bbox: { west: 500, south: 80, east: 700, north: 220 },
  name: 'South lake',
};

const STREAM: WaterBody = {
  kind: 'stream',
  path: [
    [20, 400],
    [780, 400],
  ],
  bbox: { west: 20, south: 400, east: 780, north: 400 },
  name: 'Beck',
};

describe('map water handling (T16)', () => {
  it('sets water polygon pixels to a flat surface level', () => {
    const grid = syntheticConeGrid(40, 30, 12);
    const surface = 8;
    const rings = [{ west: -8, south: -8, east: 8, north: 8 }];
    const flat = applyFlatWater(grid, rings, surface);
    const i = 20 * 40 + 20;
    expect(flat.data[i]).toBe(surface);
  });

  it('reads water rings from the Neasden Overpass fixture', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-neasden.json', import.meta.url)), 'utf8'));
    const rings = waterRingsFromOverpass(raw, { bbox: NEASDEN_FAST_BBOX });
    expect(rings.length).toBeGreaterThan(0);
    const bodies = waterBodiesFromOverpass(raw, { bbox: NEASDEN_FAST_BBOX });
    expect(bodies.some((b) => b.kind === 'lake' && b.path.length >= 4)).toBe(true);
  });
});

describe('per-water-body flattening', () => {
  it('flattens each lake to its own DEM, not the map-wide p45', () => {
    const grid = plateauGrid();
    const global = estimateWaterSurfaceM(grid);
    expect(global).toBeGreaterThan(250);

    const bodies = [NW_LAKE, SE_LAKE, STREAM];
    const local = applyLocalWater(grid, bodies);
    const nw = estimateBodySurfaceM(local, NW_LAKE);
    const se = estimateBodySurfaceM(local, SE_LAKE);
    expect(nw).toBeGreaterThan(98);
    expect(nw).toBeLessThan(104);
    expect(se).toBeGreaterThan(95);
    expect(se).toBeLessThan(101);
    expect(Math.abs(nw - se)).toBeGreaterThan(1);
    expect(nw).toBeLessThan(global - 50);
    expect(se).toBeLessThan(global - 50);

    const land = local.data[2 * local.w + 2];
    expect(land).toBeGreaterThan(300);
  });

  it('does not raise a lake above the surrounding land', () => {
    const grid = plateauGrid();
    const local = applyLocalWater(grid, [NW_LAKE, SE_LAKE]);
    const water: number[] = [];
    const land: number[] = [];
    for (let row = 0; row < local.h; row++) {
      for (let col = 0; col < local.w; col++) {
        const x = local.transform.originX + col * local.transform.pixelW;
        const y = local.transform.originY + row * local.transform.pixelH;
        const z = local.data[row * local.w + col];
        if (!Number.isFinite(z)) continue;
        if (pointInPath([x, y], NW_LAKE.path) || pointInPath([x, y], SE_LAKE.path)) water.push(z);
        else land.push(z);
      }
    }
    water.sort((a, b) => a - b);
    land.sort((a, b) => a - b);
    const waterHi = water[Math.floor(water.length * 0.9)]!;
    const landLo = land[Math.floor(land.length * 0.1)]!;
    expect(waterHi).toBeLessThan(landLo);
  });

  it('lets streams follow local terrain with a small inset', () => {
    const grid = plateauGrid();
    const local = applyLocalWater(grid, [STREAM]);
    const along: number[] = [];
    for (let col = 5; col < grid.w - 5; col++) {
      const row = Math.round((400 - grid.transform.originY) / grid.transform.pixelH);
      along.push(local.data[row * grid.w + col]);
    }
    const span = Math.max(...along) - Math.min(...along);
    expect(span).toBeGreaterThan(10);
    const origRow = Math.round((400 - grid.transform.originY) / grid.transform.pixelH);
    const orig = grid.data[origRow * grid.w + 20];
    const now = local.data[origRow * grid.w + 20];
    expect(orig - now).toBeCloseTo(STREAM_INSET_M, 3);
  });

  it('flattens the lake polygon, not land that only sits in the water bbox', () => {
    const grid = plateauGrid();
    const tri: WaterBody = {
      kind: 'lake',
      path: [
        [50, 50],
        [220, 50],
        [50, 220],
        [50, 50],
      ],
      bbox: { west: 50, south: 50, east: 220, north: 220 },
      name: 'Wedge',
    };
    for (let row = 0; row < grid.h; row++) {
      for (let col = 0; col < grid.w; col++) {
        const x = grid.transform.originX + col * grid.transform.pixelW;
        const y = grid.transform.originY + row * grid.transform.pixelH;
        if (pointInPath([x, y], tri.path)) grid.data[row * grid.w + col] = 101;
      }
    }
    const local = applyLocalWater(grid, [tri]);
    const at = (wx: number, wy: number) => {
      const col = Math.round((wx - local.transform.originX) / local.transform.pixelW);
      const row = Math.round((wy - local.transform.originY) / local.transform.pixelH);
      return local.data[row * local.w + col];
    };
    expect(at(80, 80)).toBeGreaterThan(98);
    expect(at(80, 80)).toBeLessThan(104);
    expect(at(200, 200)).toBeGreaterThan(300);
  });

  it('reads a named multipolygon relation as a lake', () => {
    const osm = {
      elements: [
        {
          type: 'relation',
          tags: { natural: 'water', name: 'Crummock Water' },
          members: [
            {
              type: 'way',
              role: 'outer',
              geometry: [
                { lon: -3.3, lat: 54.54 },
                { lon: -3.28, lat: 54.54 },
                { lon: -3.28, lat: 54.56 },
                { lon: -3.3, lat: 54.56 },
                { lon: -3.3, lat: 54.54 },
              ],
            },
          ],
        },
      ],
    };
    const bodies = waterBodiesFromOverpass(osm, { bbox: BUTTERMERE_BBOX });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].kind).toBe('lake');
    expect(bodies[0].name).toBe('Crummock Water');
  });
});

describe.skipIf(!live)('live EA Buttermere water (LIVE_MAP=1)', () => {
  it('Buttermere and Crummock sit near the EA lake surface, not a highland plateau', async () => {
    const elev = await fetchEaLidarGrid('ea-dtm', { bbox: BUTTERMERE_BBOX, resM: 16 });
    expect(elev).toBeTruthy();
    const metric = reprojectResample(elev!, { bbox: BUTTERMERE_BBOX, resM: 16, model: 'dtm' });
    const osm = await fetchOverpass(BUTTERMERE_BBOX, { allowNetwork: true, features: ['water'] });
    const bodies = waterBodiesFromOverpass(osm as Parameters<typeof waterBodiesFromOverpass>[0], { bbox: BUTTERMERE_BBOX }, metric.crs);
    const lakes = bodies.filter((b) => b.kind === 'lake');
    const butter = lakes.find((b) => /buttermere/i.test(b.name ?? ''));
    const crummock = lakes.find((b) => /crummock/i.test(b.name ?? ''));
    expect(butter, 'OSM should name Buttermere').toBeTruthy();
    expect(crummock, 'OSM should name Crummock Water').toBeTruthy();

    const global = estimateWaterSurfaceM(metric);
    expect(global).toBeGreaterThan(200);

    const butterM = estimateBodySurfaceM(metric, butter!);
    const crummockM = estimateBodySurfaceM(metric, crummock!);
    expect(Math.abs(butterM - BUTTERMERE_LAKE_M.buttermere)).toBeLessThan(2);
    expect(Math.abs(crummockM - BUTTERMERE_LAKE_M.crummock)).toBeLessThan(2);

    const local = applyLocalWater(metric, bodies);
    const water: number[] = [];
    const land: number[] = [];
    for (let row = 0; row < local.h; row++) {
      for (let col = 0; col < local.w; col++) {
        const x = local.transform.originX + col * local.transform.pixelW;
        const y = local.transform.originY + row * local.transform.pixelH;
        const z = local.data[row * local.w + col];
        if (!Number.isFinite(z)) continue;
        const inLake = lakes.some((l) => pointInWaterBody([x, y], l));
        if (inLake) water.push(z);
        else land.push(z);
      }
    }
    water.sort((a, b) => a - b);
    land.sort((a, b) => a - b);
    const waterMed = water[Math.floor(water.length * 0.5)]!;
    const landP10 = land[Math.floor(land.length * 0.1)]!;
    expect(waterMed).toBeLessThan(120);
    expect(waterMed).toBeLessThan(landP10);
    expect(waterMed).toBeLessThan(global - 50);
  }, 180_000);
});
