// Reproject elevation grids to a local metric CRS and resample to map resolution.
import proj4 from 'proj4';
import type { Float32Grid, GridTransform } from './mapGrid';
import { gridCellCentre, gridSampleBicubic } from './mapGrid';
import type { MapModel, MapSource, MapSpec } from './mapSpec';
import { highestSummitCells, prominentSummitCells } from './mapSummits';

proj4.defs(
  'EPSG:27700',
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs',
);
proj4.defs('EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs');
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');

const GB_BBOX: [number, number, number, number] = [-8.8, 49.5, 2.2, 61.0];

export function pickMetricCrs(bbox: MapSpec['bbox']): string {
  const [w, s, e, n] = bbox;
  const [gw, gs, ge, gn] = GB_BBOX;
  if (w >= gw && e <= ge && s >= gs && n <= gn) return 'EPSG:27700';
  const lon = (w + e) / 2;
  // UTM zones are 6 degrees wide. (Dividing by 12 picked a zone up to 180 degrees away,
  // which distorts and, past 90 degrees, mirrors maps outside Great Britain.)
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const north = n >= 0;
  return north ? `EPSG:326${String(zone).padStart(2, '0')}` : `EPSG:327${String(zone).padStart(2, '0')}`;
}

function ensureUtmDef(crs: string): void {
  if (crs.startsWith('EPSG:326') || crs.startsWith('EPSG:327')) {
    if (!proj4.defs(crs)) {
      const south = crs.startsWith('EPSG:327');
      const zone = Number(crs.slice(-2));
      const code = south ? `+south` : '';
      proj4.defs(crs, `+proj=utm +zone=${zone} ${code} +datum=WGS84 +units=m +no_defs`);
    }
  }
}

function project(lon: number, lat: number, crs: string): [number, number] {
  ensureUtmDef(crs);
  return proj4('EPSG:4326', crs, [lon, lat]) as [number, number];
}

export function lonLatToMetric(lon: number, lat: number, crs: string): [number, number] {
  return project(lon, lat, crs);
}

export function metricToLonLat(x: number, y: number, crs: string): [number, number] {
  ensureUtmDef(crs);
  return proj4(crs, 'EPSG:4326', [x, y]) as [number, number];
}

export function metricBounds(bbox: MapSpec['bbox'], crs: string): { west: number; south: number; east: number; north: number } {
  const [w, s, e, n] = bbox;
  const corners: [number, number][] = [[w, s], [e, s], [e, n], [w, n]];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of corners) {
    const [x, y] = project(lon, lat, crs);
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return { west, south, east, north };
}

/** Long-edge sizes a map depth grid can take. */
export const MAP_RESOLUTIONS = [128, 256, 384, 512, 768, 1024, 1536, 2048];
/** Long-edge cap for coarse sources (Terrarium, ~30 m) and the fallback when fine data is missing. */
export const MAP_FALLBACK_MAX_PX = 512;
/** Long-edge cap for fine sources built in the browser or the CLI. 2048 px belongs to cloud jobs. */
export const MAP_LOCAL_MAX_PX = 1024;
/** Long-edge cap for the cloud terrain job (Boost): fine sources only, at half the local cell. */
export const MAP_CLOUD_MAX_PX = 2048;
/** Model millimetres per grid cell a fine source is built at: a 500 mm model wants 1000 px, so 1024. */
export const MAP_TARGET_MM_PER_PX = 0.5;

/** Native ground cell of a source fine enough to beat the fallback grid, else null. */
function fineSourceNativeM(source: MapSource): number | null {
  return source === 'ea-dtm' || source === 'ea-dsm' ? 1 : null;
}

export interface MapGridSize {
  /** Ground metres per cell to aim for along the long edge. */
  resM: number;
  /** Long-edge cap in pixels. */
  maxSide: number;
}

/** Ground cell for coarse sources when Ground resolution is auto (the old default). */
export const MAP_COARSE_RES_M = 8;

/**
 * Grid size for a build. With Ground resolution on auto, fine sources (EA 1 m LiDAR) are cut at
 * 0.5 mm per cell on the model, up to 1024 px; coarse sources (Terrarium) keep 8 m and 512 px.
 * A typed Ground resolution is used as given, within the same caps. The cloud job passes
 * `maxPx` 2048, which halves the auto cell (0.25 mm on the model) for fine sources only.
 */
export function mapGridSize(
  spec: Pick<MapSpec, 'bbox' | 'resM'>,
  source: MapSource,
  masterWidthMm?: number,
  maxPx: number = MAP_LOCAL_MAX_PX,
): MapGridSize {
  const userM = Number.isFinite(spec.resM) && spec.resM > 0 ? spec.resM : null;
  const nativeM = fineSourceNativeM(source);
  if (nativeM == null) return { resM: userM ?? MAP_COARSE_RES_M, maxSide: MAP_FALLBACK_MAX_PX };
  let wantM = userM;
  if (wantM == null) {
    const b = metricBounds(spec.bbox, pickMetricCrs(spec.bbox));
    const mm = masterWidthMm != null && masterWidthMm > 0 ? masterWidthMm : 520;
    wantM = ((b.east - b.west) / mm) * MAP_TARGET_MM_PER_PX * (MAP_LOCAL_MAX_PX / maxPx);
  }
  return { resM: Math.max(nativeM, wantM), maxSide: maxPx };
}

function pickOutputSize(widthM: number, heightM: number, resM: number, maxSide = MAP_FALLBACK_MAX_PX): { w: number; h: number } {
  const sizes = MAP_RESOLUTIONS.filter((r) => r <= maxSide);
  const cap = sizes[sizes.length - 1];
  const longM = Math.max(widthM, heightM);
  let side = sizes.find((r) => longM / r <= resM * 1.05) ?? cap;
  if (longM / side > resM) {
    side = Math.min(cap, Math.max(128, Math.round(longM / resM)));
    if (!sizes.includes(side)) side = sizes.reduce((a, b) => (Math.abs(b - side) < Math.abs(a - side) ? b : a));
  }
  const aspect = widthM / heightM;
  if (aspect >= 1) return { w: side, h: Math.max(2, Math.round(side / aspect)) };
  return { w: Math.max(2, Math.round(side * aspect)), h: side };
}

function sampleSource(g: Float32Grid, x: number, y: number): number {
  return gridSampleBicubic(g, x, y, true);
}

function sourceXYToDestCell(source: Float32Grid, dest: Float32Grid, x: number, y: number): { col: number; row: number } | null {
  let mx = x;
  let my = y;
  if (source.crs !== dest.crs) {
    try {
      const [lon, lat] = proj4(source.crs, 'EPSG:4326', [x, y]) as [number, number];
      const p = proj4('EPSG:4326', dest.crs, [lon, lat]) as [number, number];
      mx = p[0];
      my = p[1];
    } catch {
      return null;
    }
  }
  const col = Math.round((mx - dest.transform.originX) / dest.transform.pixelW);
  const row = Math.round((my - dest.transform.originY) / dest.transform.pixelH);
  if (col < 0 || row < 0 || col >= dest.w || row >= dest.h) return null;
  return { col, row };
}

/**
 * Bilinear resample averages away 1-pixel summits. Stamp the DEM-max source
 * cell onto the nearest output cell. Other peaks are Jenks pins, not needles.
 */
export function stampSourceMaxima(dest: Float32Grid, source: Float32Grid): Float32Grid {
  const peaks = highestSummitCells(prominentSummitCells(source));
  if (!peaks.length) return dest;
  const out = new Float32Array(dest.data);
  for (const p of peaks) {
    const z = p.z;
    if (!Number.isFinite(z)) continue;
    const c = gridCellCentre(source, p.x, p.y);
    const cell = sourceXYToDestCell(source, dest, c.x, c.y);
    if (!cell) continue;
    const i = cell.row * dest.w + cell.col;
    const cur = out[i];
    if (!Number.isFinite(cur) || z > cur) out[i] = z;
  }
  return { ...dest, data: out };
}

/** Lattice nodes per side minus one. Over a map bbox the error is far below a source pixel. */
export const PROJECTION_LATTICE_STEPS = 32;

type XYTransform = (x: number, y: number, out: [number, number]) => void;

/**
 * proj4 costs ~1 µs per call and a 1024 px grid needs a million.
 * Project a (steps+1)² lattice over `bounds` once and interpolate bilinearly
 * between nodes; points past the edge extrapolate from the outer cell.
 */
export function projectionLattice(
  fromCrs: string,
  toCrs: string,
  bounds: { west: number; south: number; east: number; north: number },
  steps = PROJECTION_LATTICE_STEPS,
): XYTransform {
  ensureUtmDef(fromCrs);
  ensureUtmDef(toCrs);
  const conv = proj4(fromCrs, toCrs);
  const n = steps + 1;
  const dx = (bounds.east - bounds.west) / steps;
  const dy = (bounds.north - bounds.south) / steps;
  const nodes = new Float64Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [x, y] = conv.forward([bounds.west + i * dx, bounds.north - j * dy]) as [number, number];
      nodes[(j * n + i) * 2] = x;
      nodes[(j * n + i) * 2 + 1] = y;
    }
  }
  return (x, y, out) => {
    const u = (x - bounds.west) / dx;
    const v = (bounds.north - y) / dy;
    const i = Math.min(steps - 1, Math.max(0, Math.floor(u)));
    const j = Math.min(steps - 1, Math.max(0, Math.floor(v)));
    const fu = u - i;
    const fv = v - j;
    const a = (j * n + i) * 2;
    const b = a + 2;
    const c = a + n * 2;
    const d = c + 2;
    for (let k = 0; k < 2; k++) {
      const top = nodes[a + k] + (nodes[b + k] - nodes[a + k]) * fu;
      const bottom = nodes[c + k] + (nodes[d + k] - nodes[c + k]) * fu;
      out[k] = top + (bottom - top) * fv;
    }
  };
}

/** Bicubic or max-pool resample into metric CRS at `resM` ground metres per pixel (long edge), at most `maxSide` px. */
export function reprojectResample(
  source: Float32Grid,
  spec: Pick<MapSpec, 'bbox' | 'resM'> & { model?: MapModel; maxSide?: number },
): Float32Grid {
  const crs = pickMetricCrs(spec.bbox);
  const bounds = metricBounds(spec.bbox, crs);
  const widthM = bounds.east - bounds.west;
  const heightM = bounds.north - bounds.south;
  const { w, h } = pickOutputSize(widthM, heightM, spec.resM > 0 ? spec.resM : MAP_COARSE_RES_M, spec.maxSide);
  const pixelW = widthM / w;
  /** Negative: row 0 is north so the depth image, OSM, and S-01 agree. */
  const pixelH = -heightM / h;
  const data = new Float32Array(w * h);
  const useMax = spec.model === 'dsm' || spec.model === 'dtm+buildings';
  const halfW = pixelW / 2;
  const halfH = Math.abs(pixelH) / 2;
  const toSource = source.crs === crs ? null : projectionLattice(crs, source.crs, bounds);
  const at = (x: number, y: number): number => {
    if (!toSource) return gridSampleBicubic(source, x, y, true);
    toSource(x, y, xy);
    return sampleSource(source, xy[0], xy[1]);
  };
  const xy: [number, number] = [0, 0];

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const cx = bounds.west + (col + 0.5) * pixelW;
      const cy = bounds.north - (row + 0.5) * Math.abs(pixelH);
      if (!useMax) {
        data[row * w + col] = at(cx, cy);
        continue;
      }
      let best = -Infinity;
      for (const v of [at(cx - halfW, cy - halfH), at(cx + halfW, cy - halfH), at(cx + halfW, cy + halfH), at(cx - halfW, cy + halfH)]) {
        if (Number.isFinite(v) && v > best) best = v;
      }
      data[row * w + col] = Number.isFinite(best) ? best : NaN;
    }
  }

  const transform: GridTransform = {
    originX: bounds.west + pixelW / 2,
    originY: bounds.north + pixelH / 2,
    pixelW,
    pixelH,
  };
  const dest: Float32Grid = { w, h, data, crs, transform };
  return stampSourceMaxima(dest, source);
}

export function gridMetricWidthHeight(g: Float32Grid): { widthM: number; heightM: number } {
  return { widthM: g.w * Math.abs(g.transform.pixelW), heightM: g.h * Math.abs(g.transform.pixelH) };
}
