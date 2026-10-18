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

/** Lerp that falls back to whichever end is finite (NaN = nodata). Hot path: no closures. */
function lerpFinite(a: number, b: number, u: number): number {
  const fa = a === a && a !== Infinity && a !== -Infinity;
  const fb = b === b && b !== Infinity && b !== -Infinity;
  if (fa && fb) return a + (b - a) * u;
  return fa ? a : b;
}
