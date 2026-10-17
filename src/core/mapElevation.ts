// Plausible terrain elevations and nodata masking for map rasters.
import type { Float32Grid } from './mapGrid';

/** IEEE-754 float32 lowest finite value — common GeoTIFF / GDAL nodata. */
export const FLOAT32_NODATA = -3.4028235e38;

/** Dead Sea is about −430 m; anything below this is treated as missing. */
export const MAP_ELEVATION_MIN_M = -500;
/** Everest is 8848 m; anything above this is treated as missing. */
export const MAP_ELEVATION_MAX_M = 9000;

export function isPlausibleMapElevation(z: number): boolean {
  return Number.isFinite(z) && z >= MAP_ELEVATION_MIN_M && z <= MAP_ELEVATION_MAX_M;
}

function matchesNodataSentinel(z: number, sentinel: number): boolean {
  if (!Number.isFinite(sentinel)) return false;
  if (Math.abs(sentinel) > 1e20) {
    return Math.abs(z - sentinel) <= Math.abs(sentinel) * 1e-3 || (sentinel < 0 && z <= sentinel + 1);
  }
  return z === sentinel || Math.abs(z - sentinel) < 1e-3;
}

/** True when `z` is non-finite or matches GDAL / float32-min nodata. */
export function isNodataElevation(z: number, nodata: number | null | undefined): boolean {
  if (!Number.isFinite(z)) return true;
  if (nodata != null && matchesNodataSentinel(z, nodata)) return true;
  return matchesNodataSentinel(z, FLOAT32_NODATA);
}

/** Replace nodata and out-of-range samples with NaN (in place). */
export function maskElevationSamples(data: Float32Array, nodata: number | null | undefined): void {
  for (let i = 0; i < data.length; i++) {
    const z = data[i];
    if (isNodataElevation(z, nodata) || !isPlausibleMapElevation(z)) data[i] = NaN;
  }
}

/** Mean of finite samples in each output cell; NaN when a cell has none. */
export function downsampleNaNAware(
  data: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  if (srcW === dstW && srcH === dstH) return data;
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor((y * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor((x * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const v = data[yy * srcW + xx];
          if (!Number.isFinite(v)) continue;
          sum += v;
          n++;
        }
      }
      out[y * dstW + x] = n ? sum / n : NaN;
    }
  }
  return out;
}

export function sanitizeElevationGrid(grid: Float32Grid): Float32Grid {
  maskElevationSamples(grid.data, grid.nodata);
  return grid;
}
