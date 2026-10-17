// Layer budget: choose elevation plateaus per plate (equal, quantile, Jenks).
import type { Float32Grid } from './mapGrid';

export type LayerBudgetMode = 'equal' | 'quantile' | 'jenks';

export interface LayerBudgetResult {
  mode: LayerBudgetMode;
  /** N break elevations in metres (length = plateCount, ascending). */
  breaksM: number[];
}

export interface LayerBudgetApplyOpts {
  /** Non-zero cells snap down (largest break ≤ z) instead of up. */
  floorMask?: Uint8Array;
  /** Per-cell ceiling in metres (raw DEM). Applied only on floorMask cells. */
  cap?: Float32Array;
}

/** Metres: two lake pins this close collapse to one reserved level. */
export const PINNED_BREAK_EPS_M = 0.05;
/** Metres: Float32 cells sit a hair under a Float64 pin; still belong on that break. */
const SNAP_EPS_M = 1e-3;

function sampleValues(data: Float32Array, max = 8000): number[] {
  const finite: number[] = [];
  for (const v of data) if (Number.isFinite(v)) finite.push(v);
  if (finite.length <= max) return finite;
  const step = finite.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(finite[Math.floor(i * step)]);
  return out;
}

export function equalBreaks(min: number, max: number, k: number): number[] {
  if (k <= 1) return [max];
  const out: number[] = [];
  for (let i = 1; i <= k; i++) out.push(min + (i * (max - min)) / k);
  return out;
}

export function quantileBreaks(values: number[], k: number): number[] {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i <= k; i++) {
    const idx = Math.min(sorted.length - 1, Math.floor((i / k) * sorted.length) - 1);
    out.push(sorted[Math.max(0, idx)]);
  }
  return out.sort((a, b) => a - b);
}

/** Jenks natural breaks (1D, Fisher 1967). */
export function jenksBreaks(values: number[], k: number): number[] {
  const data = [...values].sort((a, b) => a - b);
  if (!data.length || k <= 0) return [];
  if (k === 1) return [data[data.length - 1]];
  const n = data.length;
  const mat = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  const s = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  for (let i = 1; i <= k; i++) {
    mat[1][i] = 1;
    s[1][i] = 0;
    for (let j = 2; j <= n; j++) s[j][i] = Infinity;
  }
  for (let l = 2; l <= n; l++) {
    let sum = 0;
    let sumSq = 0;
    let w = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = data[i3 - 1];
      w++;
      sum += val;
      sumSq += val * val;
      const variance = sumSq - (sum * sum) / w;
      const i4 = i3 - 1;
      if (i4 === 0) continue;
      for (let j = 2; j <= k; j++) {
        if (s[l][j] >= variance + s[i4][j - 1]) {
          mat[l][j] = i3;
          s[l][j] = variance + s[i4][j - 1];
        }
      }
    }
    mat[l][1] = 1;
    s[l][1] = sumSq - (sum * sum) / w;
  }
  const breaks: number[] = [];
  let kclass = n;
  for (let j = k; j >= 1; j--) {
    const idx = mat[kclass][j] - 1;
    breaks.push(data[Math.max(0, idx)]);
    kclass = Math.max(0, mat[kclass][j] - 1);
  }
  return breaks.sort((a, b) => a - b);
}

function uniqueSorted(values: number[]): number[] {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (!out.length || v - out[out.length - 1] >= PINNED_BREAK_EPS_M) out.push(v);
  }
  return out;
}

/**
 * Keep every original break (including the max-height class) and append lake pins.
 * Pins are extra levels — they must not steal summit slots from the plate budget.
 */
export function injectPinnedBreaks(breaks: number[], pins: number[], _k?: number): number[] {
  const out = uniqueSorted(breaks);
  for (const p of uniqueSorted(pins)) {
    if (out.some((b) => Math.abs(b - p) < PINNED_BREAK_EPS_M)) continue;
    out.push(p);
  }
  return out.sort((a, b) => a - b);
}

/** Gap to the previous (or next) break at `z` — one local Jenks / quantile step. */
export function localBreakStep(z: number, breaksM: number[]): number {
  const sorted = uniqueSorted(breaksM);
  if (sorted.length < 2) return SNAP_EPS_M;
  let i = 0;
  while (i < sorted.length - 1 && sorted[i] < z - SNAP_EPS_M) i++;
  const hi = sorted[i]!;
  const lo = sorted[Math.max(0, i - 1)]!;
  return Math.max(SNAP_EPS_M, hi - lo);
}

export function computeLayerBreaks(
  grid: Float32Grid,
  plateCount: number,
  mode: LayerBudgetMode,
  pinM: number[] = [],
): LayerBudgetResult {
  const values = sampleValues(grid.data, mode === 'jenks' ? 200 : 8000);
  const k = Math.max(1, Math.min(512, Math.round(plateCount)));
  if (!values.length) return { mode, breaksM: injectPinnedBreaks([], pinM, k) };
  const min = values[0];
  const max = values[values.length - 1];
  let breaksM: number[];
  if (mode === 'equal') breaksM = equalBreaks(min, max, k);
  else if (mode === 'quantile') breaksM = quantileBreaks(values, k);
  else breaksM = jenksBreaks(values, k);
  return { mode, breaksM: injectPinnedBreaks(breaksM, pinM, k) };
}

function snapCeil(z: number, sorted: number[]): number {
  let bi = 0;
  while (bi < sorted.length - 1 && z > sorted[bi] + SNAP_EPS_M) bi++;
  return sorted[bi];
}

function snapFloor(z: number, sorted: number[]): number {
  let bi = sorted.length - 1;
  while (bi > 0 && sorted[bi] > z + SNAP_EPS_M) bi--;
  return sorted[bi] > z + SNAP_EPS_M ? z : sorted[bi];
}

/** Snap one elevation onto the layer-budget plateaus (land uses `up`). */
export function snapElevation(z: number, breaksM: number[], dir: 'up' | 'down' = 'up'): number {
  const sorted = uniqueSorted(breaksM);
  if (!sorted.length || !Number.isFinite(z)) return z;
  return dir === 'down' ? snapFloor(z, sorted) : snapCeil(z, sorted);
}

/** Snap elevations to the Jenks / quantile plateaus so the stamp sees ≤ plateCount levels. */
export function applyLayerBudget(grid: Float32Grid, breaksM: number[], opts: LayerBudgetApplyOpts = {}): Float32Grid {
  if (!breaksM.length) return grid;
  const sorted = [...breaksM].sort((a, b) => a - b);
  const data = new Float32Array(grid.data.length);
  const floorMask = opts.floorMask;
  const cap = opts.cap;
  for (let i = 0; i < grid.data.length; i++) {
    const z = grid.data[i];
    if (!Number.isFinite(z)) {
      data[i] = z;
      continue;
    }
    const floor = !!floorMask?.[i];
    let snapped = floor ? snapFloor(z, sorted) : snapCeil(z, sorted);
    if (floor && cap && Number.isFinite(cap[i])) snapped = Math.min(snapped, cap[i]);
    data[i] = snapped;
  }
  return { ...grid, data };
}
