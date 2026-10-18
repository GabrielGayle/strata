// Reproject elevation grids to a local metric CRS and resample to map resolution.
import proj4 from 'proj4';
import type { Float32Grid, GridTransform } from './mapGrid';
import { gridCellCentre, gridSampleBilinear } from './mapGrid';
import type { MapModel, MapSpec } from './mapSpec';
import { DEPTH_RESOLUTIONS } from './depth';
import { prominentSummitCells } from './mapSummits';

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
  const zone = Math.floor((lon + 180) / 12) + 1;
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

function pickOutputSize(widthM: number, heightM: number, resM: number): { w: number; h: number } {
  const longM = Math.max(widthM, heightM);
  let side = DEPTH_RESOLUTIONS.find((r) => longM / r <= resM * 1.05) ?? DEPTH_RESOLUTIONS[DEPTH_RESOLUTIONS.length - 1];
  if (longM / side > resM) {
    side = Math.min(512, Math.max(128, Math.round(longM / resM)));
    if (!DEPTH_RESOLUTIONS.includes(side)) side = DEPTH_RESOLUTIONS.reduce((a, b) => (Math.abs(b - side) < Math.abs(a - side) ? b : a));
  }
  const aspect = widthM / heightM;
  if (aspect >= 1) return { w: side, h: Math.max(2, Math.round(side / aspect)) };
  return { w: Math.max(2, Math.round(side * aspect)), h: side };
}

function sampleSource(g: Float32Grid, x: number, y: number): number {
  return gridSampleBilinear(g, x, y, true);
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
 * Bilinear resample averages away 1-pixel summits. Stamp the top-N prominent
 * source peaks (and the global max) onto the nearest output cell.
 */
export function stampSourceMaxima(dest: Float32Grid, source: Float32Grid): Float32Grid {
  const peaks = prominentSummitCells(source);
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

/** Bilinear or max-pool resample into metric CRS at `resM` ground metres per pixel (long edge). */
export function reprojectResample(
  source: Float32Grid,
  spec: Pick<MapSpec, 'bbox' | 'resM'> & { model?: MapModel },
): Float32Grid {
  const crs = pickMetricCrs(spec.bbox);
  const bounds = metricBounds(spec.bbox, crs);
  const widthM = bounds.east - bounds.west;
  const heightM = bounds.north - bounds.south;
  const { w, h } = pickOutputSize(widthM, heightM, spec.resM);
  const pixelW = widthM / w;
  /** Negative: row 0 is north so the depth image, OSM, and S-01 agree. */
  const pixelH = -heightM / h;
  const data = new Float32Array(w * h);
  const useMax = spec.model === 'dsm' || spec.model === 'dtm+buildings';
  const halfW = pixelW / 2;
  const halfH = Math.abs(pixelH) / 2;

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const cx = bounds.west + (col + 0.5) * pixelW;
      const cy = bounds.north - (row + 0.5) * Math.abs(pixelH);
      if (!useMax) {
        if (source.crs === crs) {
          data[row * w + col] = gridSampleBilinear(source, cx, cy, true);
        } else {
          const [lon, lat] = proj4(crs, 'EPSG:4326', [cx, cy]) as [number, number];
          const [mx, my] = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]) as [number, number];
          data[row * w + col] = sampleSource(source, mx, my);
        }
        continue;
      }
      let best = -Infinity;
      const corners: [number, number][] = [
        [cx - halfW, cy - halfH],
        [cx + halfW, cy - halfH],
        [cx + halfW, cy + halfH],
        [cx - halfW, cy + halfH],
      ];
      for (const [px, py] of corners) {
        const v =
          source.crs === crs
            ? gridSampleBilinear(source, px, py, true)
            : (() => {
                const [lon, lat] = proj4(crs, 'EPSG:4326', [px, py]) as [number, number];
                const [mx, my] = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]) as [number, number];
                return sampleSource(source, mx, my);
              })();
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
