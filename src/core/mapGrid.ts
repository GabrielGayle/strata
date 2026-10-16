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

export function gridSampleBilinear(g: Float32Grid, x: number, y: number): number {
  const { w, h, data, transform: t } = g;
  const col = (x - t.originX) / t.pixelW - 0.5;
  const row = (y - t.originY) / t.pixelH - 0.5;
  if (col < 0 || row < 0 || col > w - 1 || row > h - 1) return NaN;
  const x0 = Math.floor(col);
  const y0 = Math.floor(row);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = col - x0;
  const ty = row - y0;
  const v = (ix: number, iy: number) => data[iy * w + ix];
  const lerp = (a: number, b: number, u: number) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * u : Number.isFinite(a) ? a : b);
  const a = lerp(v(x0, y0), v(x1, y0), tx);
  const b = lerp(v(x0, y1), v(x1, y1), tx);
  return lerp(a, b, ty);
}
