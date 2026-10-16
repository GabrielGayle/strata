// DSM / OSM building extrusion on metric grids (ticket T15). Tunable clamp for towers.
import type { Float32Grid } from './mapGrid';
import { lonLatToMetric, metricBounds } from './mapProject';
import type { MapSpec } from './mapSpec';

/** Max building rise above DTM applied before exaggeration (Neasden temple-scale). */
export const DEFAULT_BUILDING_CLAMP_M = 25;

export interface BuildingFootprint {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Roof AMSL if absolute, or height above ground when `relative` is true. */
  heightM: number;
  relative?: boolean;
}

export function buildingHeightFromTags(tags: Record<string, string>): number | null {
  const h = tags.height ?? tags['building:height'];
  if (h) {
    const n = Number(String(h).replace(/m$/i, '').trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  const lv = tags['building:levels'] ?? tags.levels;
  if (lv) {
    const n = Number(lv);
    if (Number.isFinite(n) && n > 0) return n * 3;
  }
  if (tags.building) return 9;
  return null;
}

/** Extract simple rectangular building footprints from Overpass JSON (ways with `building` tag). */
export function footprintsFromOverpass(
  data: { elements?: Array<{ type?: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }> },
  spec: Pick<MapSpec, 'bbox'>,
  crs = 'EPSG:27700',
): BuildingFootprint[] {
  const b = metricBounds(spec.bbox, crs);
  const out: BuildingFootprint[] = [];
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || !el.tags?.building || !el.geometry?.length) continue;
    const h = buildingHeightFromTags(el.tags);
    if (h == null) continue;
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
    if (east < b.west || west > b.east || north < b.south || south > b.north) continue;
    out.push({ west, south, east, north, heightM: h, relative: true });
  }
  return out;
}

function copyGrid(g: Float32Grid): Float32Grid {
  return { ...g, data: new Float32Array(g.data) };
}

function cellInFootprint(g: Float32Grid, col: number, row: number, fp: BuildingFootprint): boolean {
  const { transform: t } = g;
  const x = t.originX + col * t.pixelW;
  const y = t.originY + row * t.pixelH;
  return x >= fp.west && x <= fp.east && y >= fp.south && y <= fp.north;
}

/** Raise metric elevation inside footprints (OSM `height` / `building:levels×3`). */
export function applyBuildingFootprints(dtm: Float32Grid, footprints: BuildingFootprint[]): Float32Grid {
  if (!footprints.length) return dtm;
  const grid = copyGrid(dtm);
  const { w, h, data } = grid;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = row * w + col;
      const base = data[i];
      if (!Number.isFinite(base)) continue;
      for (const fp of footprints) {
        if (!cellInFootprint(grid, col, row, fp)) continue;
        const roof = fp.relative ? base + fp.heightM : fp.heightM;
        if (roof > data[i]) data[i] = roof;
      }
    }
  }
  return grid;
}

/** Cap DSM − DTM delta so one tower cannot eat the whole layer budget. */
export function clampTowerRise(dsm: Float32Grid, dtm: Float32Grid, maxDeltaM: number): Float32Grid {
  const cap = Math.max(0, maxDeltaM);
  const out = copyGrid(dsm);
  for (let i = 0; i < out.data.length; i++) {
    const b = dtm.data[i];
    const d = out.data[i];
    if (!Number.isFinite(b) || !Number.isFinite(d)) continue;
    const rise = d - b;
    if (rise > cap) out.data[i] = b + cap;
  }
  return out;
}

export function resolveElevationSourceForModel(effective: MapSpec['source'], model: MapSpec['model']): MapSpec['source'] {
  if (model === 'dsm' && effective === 'ea-dtm') return 'ea-dsm';
  return effective;
}

export function buildingClampMetres(spec: Pick<MapSpec, 'buildingClampM'>): number {
  const n = spec.buildingClampM;
  return Number.isFinite(n) && n! > 0 ? n! : DEFAULT_BUILDING_CLAMP_M;
}
