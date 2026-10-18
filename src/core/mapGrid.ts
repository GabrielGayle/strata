// Shared elevation grid types for map fetch → project → depth.

export interface GridTransform {
  /** World X (metres) at pixel (0,0) centre. */
  originX: number;
  /** World Y (metres) at pixel (0,0) centre. */
  originY: number;
  /** Metres per pixel along +X. */
  pixelW: number;
  /** Metres per pixel along +Y (negative when rows grow south/down). */
  pixelH: number;
}

export interface Float32Grid {
  w: number;
  h: number;
  data: Float32Array;
  /** CRS identifier (EPSG:3857, EPSG:27700, …). */
  crs: string;
  transform: GridTransform;
  /** Value treated as missing (NaN in data). */
  nodata?: number;
}

/** Finite elevation range of a grid (metres). */
export function gridFiniteMinMax(data: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** World metres at the centre of cell (col, row). */
export function gridCellCentre(g: Float32Grid, col: number, row: number): { x: number; y: number } {
  const t = g.transform;
  return { x: t.originX + col * t.pixelW, y: t.originY + row * t.pixelH };
}

/** True when row 0 is the north edge (GeoTIFF / map-image convention). */
export function gridRow0IsNorth(g: Float32Grid): boolean {
  return g.transform.pixelH < 0;
}

/** Bilinear sample at world (x, y). The transform origin is the centre of cell (0, 0). */
export function gridSampleBilinear(g: Float32Grid, x: number, y: number, clamp = false): number {
  const { w, h, data, transform: t } = g;
  let col = (x - t.originX) / t.pixelW;
  let row = (y - t.originY) / t.pixelH;
  if (clamp) {
    col = Math.min(w - 1, Math.max(0, col));
    row = Math.min(h - 1, Math.max(0, row));
  } else if (col < 0 || row < 0 || col > w - 1 || row > h - 1) return NaN;
  const x0 = Math.floor(col);
  const y0 = Math.floor(row);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = col - x0;
  const ty = row - y0;
  const a = lerpFinite(data[y0 * w + x0], data[y0 * w + x1], tx);
  const b = lerpFinite(data[y1 * w + x0], data[y1 * w + x1], tx);
  return lerpFinite(a, b, ty);
}

/**
 * Bicubic (Catmull-Rom) sample at world (x, y), so heights have no kink at every
 * cell edge. The result stays inside the four nearest cells' range (no ringing
 * above a summit or below a lake), and any nodata nearby falls back to bilinear.
 */
export function gridSampleBicubic(g: Float32Grid, x: number, y: number, clamp = false): number {
  const { w, h, transform: t } = g;
  let col = (x - t.originX) / t.pixelW;
  let row = (y - t.originY) / t.pixelH;
  if (clamp) {
    col = Math.min(w - 1, Math.max(0, col));
    row = Math.min(h - 1, Math.max(0, row));
  } else if (col < 0 || row < 0 || col > w - 1 || row > h - 1) return NaN;
  return cubicAt(g.data, w, h, col, row);
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Clamped Catmull-Rom at fractional cell (col, row) of a row-major grid; nodata falls back to bilinear. */
export function cubicAt(data: ArrayLike<number>, w: number, h: number, col: number, row: number): number {
  const x1 = Math.floor(col);
  const y1 = Math.floor(row);
  const tx = col - x1;
  const ty = row - y1;
  // hot path (every plate-top sample): no closures
  const xs1 = x1 < 0 ? 0 : x1 > w - 1 ? w - 1 : x1;
  const xs0 = xs1 > 0 ? xs1 - 1 : 0;
  const xs2 = xs1 < w - 1 ? xs1 + 1 : w - 1;
  const xs3 = xs2 < w - 1 ? xs2 + 1 : w - 1;
  const y1c = y1 < 0 ? 0 : y1 > h - 1 ? h - 1 : y1;
  let lo = Infinity, hi = -Infinity;
  let acc0 = 0, acc1 = 0, acc2 = 0, acc3 = 0;
  for (let k = 0; k < 4; k++) {
    const yk = y1c - 1 + k;
    const base = (yk < 0 ? 0 : yk > h - 1 ? h - 1 : yk) * w;
    const a = data[base + xs0], b = data[base + xs1], c = data[base + xs2], d = data[base + xs3];
    if (!(isFin(a) && isFin(b) && isFin(c) && isFin(d))) return bilinearAt(data, w, h, col, row);
    if (k === 1 || k === 2) {
      lo = Math.min(lo, b, c);
      hi = Math.max(hi, b, c);
    }
    const r = catmullRom(a, b, c, d, tx);
    if (k === 0) acc0 = r;
    else if (k === 1) acc1 = r;
    else if (k === 2) acc2 = r;
    else acc3 = r;
  }
  const z = catmullRom(acc0, acc1, acc2, acc3, ty);
  return z < lo ? lo : z > hi ? hi : z;
}

/** Bilinear at fractional cell (col, row), edges clamped, nodata-aware. */
export function bilinearAt(data: ArrayLike<number>, w: number, h: number, col: number, row: number): number {
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(col)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(row)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = col - x0;
  const ty = row - y0;
  const a = lerpFinite(data[y0 * w + x0], data[y0 * w + x1], tx);
  const b = lerpFinite(data[y1 * w + x0], data[y1 * w + x1], tx);
  return lerpFinite(a, b, ty);
}

function isFin(v: number): boolean {
  return v === v && v !== Infinity && v !== -Infinity;
}

/** Lerp that falls back to whichever end is finite (NaN = nodata). Hot path: no closures. */
function lerpFinite(a: number, b: number, u: number): number {
  const fa = a === a && a !== Infinity && a !== -Infinity;
  const fb = b === b && b !== Infinity && b !== -Infinity;
  if (fa && fb) return a + (b - a) * u;
  return fa ? a : b;
}
