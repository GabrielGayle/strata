// Elevation grid (metres AMSL) → DepthData for the existing image / slicer pipeline.
import type { DepthData, DepthSettings } from './depth';
import { defaultDepthSettings } from './depth';
import type { Float32Grid } from './mapGrid';
import { gridMetricWidthHeight } from './mapProject';

function b64FromU16(words: Uint16Array): string {
  const b = Buffer.alloc(words.length * 2);
  for (let i = 0; i < words.length; i++) b.writeUInt16LE(words[i], i * 2);
  return b.toString('base64');
}

function percentile(vals: number[], p: number): number {
  if (!vals.length) return NaN;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
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
}

/**
 * Convert metric elevation to DepthData: depth = zTop − elevation (high ground = smaller depth = darker).
 */
export function mapGridToDepth(grid: Float32Grid, opts: MapToDepthOptions = {}): { depth: DepthData; meta: MapDepthMeta } {
  const { widthM, heightM } = gridMetricWidthHeight(grid);
  const finite: number[] = [];
  for (const v of grid.data) if (Number.isFinite(v)) finite.push(v);
  if (!finite.length) throw new Error('Map grid has no elevation samples');
  const zTop = percentile(finite, 98);
  const ex = opts.exaggeration != null && opts.exaggeration > 0 ? opts.exaggeration : 1;
  const n = grid.w * grid.h;
  const depths = new Float32Array(n);
  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < n; i++) {
    const z = grid.data[i];
    if (!Number.isFinite(z)) {
      depths[i] = NaN;
      continue;
    }
    const d = Math.max(1e-3, (zTop - z) * ex + 1e-3);
    depths[i] = d;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  if (!(maxD > minD)) {
    minD = 0;
    maxD = 1;
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
  const settings: DepthSettings = {
    ...defaultDepthSettings({ nearM, farM }, false),
    resolution: opts.resolution ?? 384,
    matte: false,
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
  };
  return {
    depth,
    meta: { widthM, heightM, zTopM: zTop, exaggeration: ex },
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
