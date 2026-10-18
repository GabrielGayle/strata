// Elevation grid (metres AMSL) → DepthData for the existing image / slicer pipeline.
import type { DepthData, DepthSettings, MapOrthoMeta } from './depth';
import { defaultDepthSettings } from './depth';
import { MapTerrainBuildError } from './mapBuildError';
import { isPlausibleMapElevation } from './mapElevation';
import type { Float32Grid } from './mapGrid';
import { gridMetricWidthHeight } from './mapProject';

const B64 = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

/** Little-endian uint16 as base64, written straight into a byte buffer (a 1024 px grid is 2.8 MB). */
export function b64FromU16(words: Uint16Array): string {
  const b = new Uint8Array(words.length * 2);
  const view = new DataView(b.buffer);
  for (let i = 0; i < words.length; i++) view.setUint16(i * 2, words[i], true);
  const out = new Uint8Array(Math.ceil(b.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out[o++] = B64[n >> 18];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = B64[(n >> 6) & 63];
    out[o++] = B64[n & 63];
  }
  const rest = b.length - i;
  if (rest > 0) {
    const n = (b[i] << 16) | (rest > 1 ? b[i + 1] << 8 : 0);
    out[o++] = B64[n >> 18];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = rest > 1 ? B64[(n >> 6) & 63] : 61;
    out[o++] = 61;
  }
  return new TextDecoder().decode(out);
}

export interface MapDepthMeta {
  /** Ground width covered by the grid (metres). */
  widthM: number;
  heightM: number;
  zTopM: number;
  exaggeration: number;
}

export interface MapToDepthOptions {
  /** Vertical exaggeration factor (1 = true scale in depth encoding). */
  exaggeration?: number;
  resolution?: number;
  bbox?: [number, number, number, number];
}

/**
 * Convert metric elevation to DepthData.
 * Uses true min/max (not p2/p98). Encoded metres = (zMax − z) × exaggeration.
 * Linear spacing, flatten off — map faces must not go through the photo pipeline.
 */
export function mapGridToDepth(grid: Float32Grid, opts: MapToDepthOptions = {}): { depth: DepthData; meta: MapDepthMeta } {
  const { widthM, heightM } = gridMetricWidthHeight(grid);
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const v of grid.data) {
    if (!isPlausibleMapElevation(v)) continue;
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  if (!(zMax >= zMin) || !Number.isFinite(zMin)) {
    throw new MapTerrainBuildError('Map grid has no elevation samples');
  }
  const ex = opts.exaggeration != null && opts.exaggeration > 0 ? opts.exaggeration : 1;
  const n = grid.w * grid.h;
  const depths = new Float32Array(n);
  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < n; i++) {
    const z = grid.data[i];
    if (!isPlausibleMapElevation(z)) {
      depths[i] = NaN;
      continue;
    }
    // q=0 is "no depth" in decodeDepthBuffers, so keep a tiny floor.
    const d = Math.max(1e-3, (zMax - z) * ex + 1e-3);
    depths[i] = d;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  if (!(maxD > minD)) {
    minD = 1e-3;
    maxD = 1e-3 + Math.max(1e-3, (zMax - zMin) * ex);
  }
  const nearM = minD;
  const farM = maxD;
  const words = new Uint16Array(n);
  const span = maxD - minD;
  for (let i = 0; i < n; i++) {
    const d = depths[i];
    if (!Number.isFinite(d)) {
      words[i] = 0;
      continue;
    }
    const q = 1 + Math.round(((d - minD) / (span || 1)) * 65534);
    words[i] = Math.min(65535, Math.max(1, q));
  }
  const reliefM = Math.max(0, zMax - zMin);
  const mapOrtho: MapOrthoMeta = {
    source: 'map',
    widthM,
    heightM,
    reliefM,
    zMinM: zMin,
    zMaxM: zMax,
    bboxKm: `${(widthM / 1000).toFixed(2)} × ${(heightM / 1000).toFixed(2)} km`,
  };
  const settings: DepthSettings = {
    ...defaultDepthSettings({ nearM, farM, mapOrtho }, false),
    spacing: 'linear',
    flatten: 0,
    curve: 1,
    matte: false,
    resolution: opts.resolution ?? 384,
  };
  const depth: DepthData = {
    w: grid.w,
    h: grid.h,
    minM: minD,
    maxM: maxD,
    nearM,
    farM,
    data: b64FromU16(words),
    settings,
    mapOrtho,
  };
  return {
    depth,
    meta: { widthM, heightM, zTopM: zMax, exaggeration: ex },
  };
}

/** Synthetic cone elevation field for tests (metres). */
export function syntheticConeGrid(size = 64, radiusM = 30, heightM = 20): Float32Grid {
  const w = size;
  const h = size;
  const data = new Float32Array(w * h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const res = (2 * radiusM) / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) * res;
      const dy = (y - cy) * res;
      const r = Math.hypot(dx, dy);
      data[y * w + x] = r <= radiusM ? heightM * (1 - r / radiusM) : 0;
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: -radiusM + res / 2, originY: radiusM - res / 2, pixelW: res, pixelH: -res },
  };
}
