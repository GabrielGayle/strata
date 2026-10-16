// Water handling: flat surface level on OSM polygons (ticket T16). Bathymetry lands in T24.
import type { Float32Grid } from './mapGrid';
import { lonLatToMetric } from './mapProject';
import type { MapSpec } from './mapSpec';

export interface WaterRing {
  west: number;
  south: number;
  east: number;
  north: number;
}

function copyGrid(g: Float32Grid): Float32Grid {
  return { ...g, data: new Float32Array(g.data) };
}

export function waterRingsFromOverpass(
  data: { elements?: Array<{ type?: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }> },
  _spec: Pick<MapSpec, 'bbox'>,
  crs = 'EPSG:27700',
): WaterRing[] {
  const out: WaterRing[] = [];
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || !el.geometry?.length) continue;
    const tags = el.tags ?? {};
    const water = tags.natural === 'water' || tags.waterway || tags.water;
    if (!water) continue;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const p of el.geometry) {
      const [x, y] = lonLatToMetric(p.lon, p.lat, crs);
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
    out.push({ west, south, east, north });
  }
  return out;
}

function inRing(g: Float32Grid, col: number, row: number, ring: WaterRing): boolean {
  const { transform: t } = g;
  const x = t.originX + col * t.pixelW;
  const y = t.originY + row * t.pixelH;
  return x >= ring.west && x <= ring.east && y >= ring.south && y <= ring.north;
}

/** Set water pixels to a flat surface elevation (metres AMSL). */
export function applyFlatWater(grid: Float32Grid, rings: WaterRing[], surfaceM: number): Float32Grid {
  if (!rings.length) return grid;
  const out = copyGrid(grid);
  const { w, h, data } = out;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = row * w + col;
      for (const ring of rings) {
        if (inRing(out, col, row, ring)) {
          data[i] = surfaceM;
          break;
        }
      }
    }
  }
  return out;
}

export function estimateWaterSurfaceM(grid: Float32Grid): number {
  const finite: number[] = [];
  for (const v of grid.data) if (Number.isFinite(v)) finite.push(v);
  if (!finite.length) return 0;
  finite.sort((a, b) => a - b);
  return finite[Math.floor(finite.length * 0.45)] ?? finite[0];
}
