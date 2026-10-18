// Top-N prominent peaks on a DEM — two linear scans, spatial bins, no flood.
import type { Float32Grid } from './mapGrid';

/** Only consider high ground in the top 40% of relief. */
export const SUMMIT_BAND_FRAC = 0.4;
/** Extra summit pins / restored cells (Grasmoor, Crag Hill, High Stile, …). */
export const MAX_SUMMIT_PINS = 12;
/** Same-height neighbours still sit on that summit plateau. */
const PLATEAU_EPS_M = 0.05;

export interface SummitCell {
  x: number;
  y: number;
  z: number;
  i: number;
}

/**
 * No 8-neighbour is higher. Plateau interiors qualify; slope cells do not.
 * Prefer the most interior cell in a bin so restore does not re-jag rims.
 */
function plateauInteriorScore(data: Float32Array, w: number, h: number, x: number, y: number, z: number): number | null {
  let equal = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = data[ny * w + nx];
      if (!Number.isFinite(n)) continue;
      if (n > z + 1e-3) return null;
      if (Math.abs(n - z) <= PLATEAU_EPS_M) equal++;
    }
  }
  return equal;
}

/**
 * True peaks in the summit band: no higher 8-neighbour, one per spatial bin,
 * then top-N by elevation. Always includes the global max. Tie-break prefers
 * plateau interiors so stamp/restore do not reintroduce simplified rims.
 */
export function prominentSummitCells(grid: Float32Grid): SummitCell[] {
  const { w, h, data } = grid;
  let min = Infinity;
  let max = -Infinity;
  let global: SummitCell | undefined;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z = data[i];
      if (!Number.isFinite(z)) continue;
      if (z < min) min = z;
      if (!global || z > global.z) {
        max = z;
        global = { x, y, z, i };
      }
    }
  }
  if (!(max > min) || !global || !Number.isFinite(max)) return [];
  const minDistPx = Math.max(4, Math.round(0.06 * Math.min(w, h)));
  const bw = Math.max(1, Math.ceil(w / minDistPx));
  const bh = Math.max(1, Math.ceil(h / minDistPx));
  const bins = new Array<SummitCell | undefined>(bw * bh);
  const interior = new Float32Array(bw * bh);
  const band = max - SUMMIT_BAND_FRAC * (max - min);

  for (let y = 0; y < h; y++) {
    const by = Math.min(bh - 1, (y / minDistPx) | 0);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z = data[i];
      if (!Number.isFinite(z) || z < band) continue;
      const score = plateauInteriorScore(data, w, h, x, y, z);
      if (score == null && z < max - PLATEAU_EPS_M) continue;
      const bx = Math.min(bw - 1, (x / minDistPx) | 0);
      const bi = by * bw + bx;
      const prev = bins[bi];
      const eq = score ?? -1;
      if (!prev || z > prev.z || (z >= prev.z - 1e-4 && eq > interior[bi]!)) {
        bins[bi] = { x, y, z, i };
        interior[bi] = eq;
      }
    }
  }

  const ranked: SummitCell[] = [];
  for (const b of bins) if (b) ranked.push(b);
  ranked.sort((a, b) => b.z - a.z);

  const kept: SummitCell[] = [];
  const tryKeep = (c: SummitCell) => {
    if (kept.some((k) => k.i === c.i || Math.hypot(k.x - c.x, k.y - c.y) < minDistPx)) return;
    kept.push(c);
  };
  tryKeep(global);
  for (const c of ranked) {
    if (kept.length >= MAX_SUMMIT_PINS) break;
    tryKeep(c);
  }
  return kept;
}

/** Distinct summit elevations (metres) for extra Jenks pins. */
export function localMaximaElevations(grid: Float32Grid): number[] {
  const zs = prominentSummitCells(grid)
    .map((p) => p.z)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of zs) {
    if (!out.length || z - out[out.length - 1]! >= PLATEAU_EPS_M) out.push(z);
  }
  return out;
}
