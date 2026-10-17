// Water: each lake flattens to its own DEM surface; streams follow (or inset) local terrain.
import type { Float32Grid } from './mapGrid';
import { lonLatToMetric } from './mapProject';
import type { MapSpec } from './mapSpec';
import { pointInPath, type Path } from './geom2d';

export interface WaterRing {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type WaterKind = 'lake' | 'stream';

export interface WaterBody {
  kind: WaterKind;
  /** Metric ring (lakes) or polyline (streams). */
  path: Path;
  /** Inner rings (islands) for multipolygon lakes. */
  holes?: Path[];
  bbox: WaterRing;
  name?: string;
}

/** Metres to drop stream cells below the sampled DEM. Lakes are never this. */
export const STREAM_INSET_M = 0.4;

interface OverpassNode {
  lat: number;
  lon: number;
}

interface OverpassEl {
  type?: string;
  tags?: Record<string, string>;
  geometry?: OverpassNode[];
  members?: { type?: string; role?: string; geometry?: OverpassNode[] }[];
}

function copyGrid(g: Float32Grid): Float32Grid {
  return { ...g, data: new Float32Array(g.data) };
}

function cellCentre(g: Float32Grid, col: number, row: number): { x: number; y: number } {
  const t = g.transform;
  return { x: t.originX + col * t.pixelW, y: t.originY + row * t.pixelH };
}

function closePath(path: Path): Path {
  if (path.length < 2) return path;
  const a = path[0];
  const b = path[path.length - 1];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) return path;
  return [...path, a];
}

function isClosed(path: Path): boolean {
  if (path.length < 4) return false;
  const a = path[0];
  const b = path[path.length - 1];
  const span = Math.hypot(path[0][0] - path[1][0], path[0][1] - path[1][1]) || 1;
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < Math.max(1, span * 4);
}

function bboxOfPath(path: Path, holes: Path[] = []): WaterRing {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (ring: Path) => {
    for (const [x, y] of ring) {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
  };
  visit(path);
  for (const h of holes) visit(h);
  return { west, south, east, north };
}

const STREAM_WATER = new Set(['stream', 'river', 'canal', 'rapids', 'ditch', 'drain', 'brook', 'beck']);
const STREAM_WATERWAY = new Set(['stream', 'river', 'canal', 'rapids', 'ditch', 'drain', 'riverbank']);

/** Bbox length/width; long thin water polygons follow terrain like streams. */
export function pathElongation(path: Path): number {
  const b = bboxOfPath(path);
  const w = Math.max(1e-6, b.east - b.west);
  const h = Math.max(1e-6, b.north - b.south);
  return Math.max(w, h) / Math.min(w, h);
}

export function classifyWater(tags: Record<string, string>, path: Path): WaterKind | null {
  const natural = (tags.natural ?? '').toLowerCase();
  const water = (tags.water ?? '').toLowerCase();
  const waterway = (tags.waterway ?? '').toLowerCase();
  if (STREAM_WATER.has(water) || STREAM_WATERWAY.has(waterway)) return 'stream';
  const lakeish =
    natural === 'water' ||
    water === 'lake' ||
    water === 'pond' ||
    water === 'reservoir' ||
    water === 'oxbow' ||
    waterway === 'dock';
  if (lakeish && (isClosed(path) || path.length >= 4)) {
    return pathElongation(path) >= 5 ? 'stream' : 'lake';
  }
  if (waterway || water) {
    if (!isClosed(path)) return 'stream';
    return pathElongation(path) >= 5 ? 'stream' : 'lake';
  }
  return null;
}

function metricPath(geom: OverpassNode[] | undefined, crs: string): Path | null {
  if (!geom?.length) return null;
  const path: Path = geom.map((p) => lonLatToMetric(p.lon, p.lat, crs));
  return path.length >= 2 ? path : null;
}

function bodiesFromElement(el: OverpassEl, crs: string): WaterBody[] {
  const tags = el.tags ?? {};
  const name = tags.name?.trim();
  const named = name ? { name } : {};

  if (el.type === 'relation' && el.members?.length) {
    const outers: Path[] = [];
    const holes: Path[] = [];
    for (const m of el.members) {
      const path = metricPath(m.geometry, crs);
      if (!path) continue;
      const role = (m.role ?? 'outer').toLowerCase();
      if (role === 'inner' || role === 'hole' || role === 'island') holes.push(closePath(path));
      else outers.push(closePath(path));
    }
    const out: WaterBody[] = [];
    for (const outer of outers) {
      const kind = classifyWater(tags, outer);
      if (!kind) continue;
      const ownHoles = kind === 'lake' ? holes.filter((h) => h.some((pt) => pointInPath(pt, outer))) : [];
      out.push({
        kind,
        path: outer,
        ...(ownHoles.length ? { holes: ownHoles } : {}),
        bbox: bboxOfPath(outer, ownHoles),
        ...named,
      });
    }
    return out;
  }

  if (el.type !== 'way') return [];
  const path = metricPath(el.geometry, crs);
  if (!path) return [];
  const kind = classifyWater(tags, path);
  if (!kind) return [];
  const ring = kind === 'lake' ? closePath(path) : path;
  return [{ kind, path: ring, bbox: bboxOfPath(ring), ...named }];
}

export function waterBodiesFromOverpass(
  data: { elements?: OverpassEl[] },
  _spec: Pick<MapSpec, 'bbox'>,
  crs = 'EPSG:27700',
): WaterBody[] {
  const out: WaterBody[] = [];
  for (const el of data.elements ?? []) out.push(...bodiesFromElement(el, crs));
  return out;
}

export function waterRingsFromOverpass(
  data: { elements?: OverpassEl[] },
  spec: Pick<MapSpec, 'bbox'>,
  crs = 'EPSG:27700',
): WaterRing[] {
  return waterBodiesFromOverpass(data, spec, crs).map((b) => b.bbox);
}

function inRing(g: Float32Grid, col: number, row: number, ring: WaterRing): boolean {
  const { x, y } = cellCentre(g, col, row);
  return x >= ring.west && x <= ring.east && y >= ring.south && y <= ring.north;
}

export function pointInWaterBody(pt: [number, number], body: WaterBody): boolean {
  if (body.kind === 'stream') return false;
  if (!pointInPath(pt, body.path)) return false;
  if (body.holes?.some((h) => pointInPath(pt, h))) return false;
  return true;
}

function gridWindow(g: Float32Grid, box: WaterRing): { c0: number; c1: number; r0: number; r1: number } {
  const t = g.transform;
  const cols = [0, g.w - 1, (box.west - t.originX) / t.pixelW, (box.east - t.originX) / t.pixelW].map((c) =>
    Math.min(g.w - 1, Math.max(0, Math.round(c))),
  );
  const rows = [0, g.h - 1, (box.south - t.originY) / t.pixelH, (box.north - t.originY) / t.pixelH].map((r) =>
    Math.min(g.h - 1, Math.max(0, Math.round(r))),
  );
  return { c0: Math.min(...cols), c1: Math.max(...cols), r0: Math.min(...rows), r1: Math.max(...rows) };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[i];
}

function interiorSamples(grid: Float32Grid, body: WaterBody): number[] {
  const { c0, c1, r0, r1 } = gridWindow(grid, body.bbox);
  const zs: number[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const { x, y } = cellCentre(grid, col, row);
      if (!pointInWaterBody([x, y], body)) continue;
      const z = grid.data[row * grid.w + col];
      if (Number.isFinite(z)) zs.push(z);
    }
  }
  return zs;
}

function shorelineSamples(grid: Float32Grid, body: WaterBody): number[] {
  const { c0, c1, r0, r1 } = gridWindow(grid, body.bbox);
  const inside = (col: number, row: number) => {
    if (col < 0 || row < 0 || col >= grid.w || row >= grid.h) return false;
    const { x, y } = cellCentre(grid, col, row);
    return pointInWaterBody([x, y], body);
  };
  const zs: number[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (!inside(col, row)) continue;
      const edge = !inside(col - 1, row) || !inside(col + 1, row) || !inside(col, row - 1) || !inside(col, row + 1);
      if (!edge) continue;
      const z = grid.data[row * grid.w + col];
      if (Number.isFinite(z)) zs.push(z);
    }
  }
  return zs;
}

/** Surface of one lake from DEM samples inside its polygon (not the map-wide p45). */
export function estimateBodySurfaceM(grid: Float32Grid, body: WaterBody): number {
  const shore = shorelineSamples(grid, body);
  shore.sort((a, b) => a - b);
  if (shore.length >= 8) return percentile(shore, 0.5);
  const interior = interiorSamples(grid, body);
  interior.sort((a, b) => a - b);
  if (!interior.length) return NaN;
  return percentile(interior, 0.15);
}

/** Set water pixels to a flat surface elevation (metres AMSL). Kept for bbox-mode tests. */
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

function distToSeg(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function distToPath(px: number, py: number, path: Path): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) best = Math.min(best, distToSeg(px, py, path[i - 1], path[i]));
  return best;
}

export const WATER_KIND_LAND = 0;
export const WATER_KIND_LAKE = 1;
export const WATER_KIND_STREAM = 2;

export interface LocalWaterResult {
  grid: Float32Grid;
  /** Distinct lake surface elevations to reserve as snapping levels. */
  lakeSurfacesM: number[];
  /** 0 = land, 1 = lake, 2 = stream. */
  waterKind: Uint8Array;
  /** Per-cell lake surface (NaN on non-lake cells). */
  lakeLevelM: Float32Array;
}

function addLakeSurface(list: number[], surface: number): void {
  if (!Number.isFinite(surface)) return;
  if (list.some((p) => Math.abs(p - surface) < 0.01)) return;
  list.push(surface);
}

/**
 * Lakes: flatten each polygon to its own local surface.
 * Streams: follow the DEM with a small inset — never a map-wide level.
 * Overlapping waterways take the minimum (do not stack insets).
 */
export function applyLocalWaterResult(grid: Float32Grid, bodies: WaterBody[]): LocalWaterResult {
  const waterKind = new Uint8Array(grid.w * grid.h);
  const lakeLevelM = new Float32Array(grid.w * grid.h).fill(NaN);
  const lakeSurfacesM: number[] = [];
  if (!bodies.length) return { grid, lakeSurfacesM, waterKind, lakeLevelM };

  const out = copyGrid(grid);
  const lakes = bodies.filter((b) => b.kind === 'lake');
  const streams = bodies.filter((b) => b.kind === 'stream');

  for (const lake of lakes) {
    const surface = estimateBodySurfaceM(grid, lake);
    if (!Number.isFinite(surface)) continue;
    addLakeSurface(lakeSurfacesM, surface);
    const { c0, c1, r0, r1 } = gridWindow(out, lake.bbox);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const { x, y } = cellCentre(out, col, row);
        if (!pointInWaterBody([x, y], lake)) continue;
        const i = row * out.w + col;
        const raw = grid.data[i];
        if (!Number.isFinite(raw)) continue;
        const flat = Math.min(raw, surface);
        out.data[i] = waterKind[i] === WATER_KIND_LAKE ? Math.min(out.data[i], flat) : flat;
        waterKind[i] = WATER_KIND_LAKE;
        const prev = lakeLevelM[i];
        lakeLevelM[i] = Number.isFinite(prev) ? Math.min(prev, surface) : surface;
      }
    }
  }

  const half = Math.max(Math.abs(out.transform.pixelW), Math.abs(out.transform.pixelH), 2);
  for (const stream of streams) {
    const pad = { west: stream.bbox.west - half, south: stream.bbox.south - half, east: stream.bbox.east + half, north: stream.bbox.north + half };
    const { c0, c1, r0, r1 } = gridWindow(out, pad);
    const closed = isClosed(stream.path);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * out.w + col;
        if (waterKind[i] === WATER_KIND_LAKE) continue;
        const { x, y } = cellCentre(out, col, row);
        const inside = closed && pointInPath([x, y], stream.path);
        if (!inside && distToPath(x, y, stream.path) > half) continue;
        const raw = grid.data[i];
        if (!Number.isFinite(raw)) continue;
        const target = raw - STREAM_INSET_M;
        const cur = out.data[i];
        out.data[i] = Number.isFinite(cur) ? Math.min(cur, target) : target;
        waterKind[i] = WATER_KIND_STREAM;
      }
    }
  }
  return { grid: out, lakeSurfacesM, waterKind, lakeLevelM };
}

export function applyLocalWater(grid: Float32Grid, bodies: WaterBody[]): Float32Grid {
  return applyLocalWaterResult(grid, bodies).grid;
}

/** Re-apply lake surfaces / stream caps after snapping and simplify so water never sits above the DEM. */
export function restoreWaterSurfaces(grid: Float32Grid, raw: Float32Grid, water: Pick<LocalWaterResult, 'waterKind' | 'lakeLevelM'>): Float32Grid {
  const out = copyGrid(grid);
  for (let i = 0; i < out.data.length; i++) {
    const kind = water.waterKind[i];
    if (!kind) continue;
    const cap = raw.data[i];
    if (!Number.isFinite(cap)) continue;
    if (kind === WATER_KIND_LAKE) {
      const surface = water.lakeLevelM[i];
      out.data[i] = Number.isFinite(surface) ? Math.min(surface, cap) : Math.min(out.data[i], cap);
    } else {
      const z = out.data[i];
      const lowered = Number.isFinite(z) ? Math.min(z, cap - STREAM_INSET_M) : cap - STREAM_INSET_M;
      out.data[i] = Math.min(lowered, cap);
    }
  }
  return out;
}

/** Map-wide 45th percentile — legacy global flatten (raises lakes at Buttermere). */
export function estimateWaterSurfaceM(grid: Float32Grid): number {
  const finite: number[] = [];
  for (const v of grid.data) if (Number.isFinite(v)) finite.push(v);
  if (!finite.length) return 0;
  finite.sort((a, b) => a - b);
  return finite[Math.floor(finite.length * 0.45)] ?? finite[0];
}
