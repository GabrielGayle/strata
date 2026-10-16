// Layer budget: choose elevation plateaus per plate (equal, quantile, Jenks).
import type { Float32Grid } from './mapGrid';

export type LayerBudgetMode = 'equal' | 'quantile' | 'jenks';

export interface LayerBudgetResult {
  mode: LayerBudgetMode;
  /** N break elevations in metres (length = plateCount, ascending). */
  breaksM: number[];
}

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

export function computeLayerBreaks(grid: Float32Grid, plateCount: number, mode: LayerBudgetMode): LayerBudgetResult {
  const values = sampleValues(grid.data, mode === 'jenks' ? 200 : 8000);
  const k = Math.max(1, Math.min(512, Math.round(plateCount)));
  if (!values.length) return { mode, breaksM: [] };
  const min = values[0];
  const max = values[values.length - 1];
  let breaksM: number[];
  if (mode === 'equal') breaksM = equalBreaks(min, max, k);
  else if (mode === 'quantile') breaksM = quantileBreaks(values, k);
  else breaksM = jenksBreaks(values, k);
  return { mode, breaksM };
}

/** Snap elevations to the Jenks / quantile plateaus so the stamp sees ≤ plateCount levels. */
export function applyLayerBudget(grid: Float32Grid, breaksM: number[]): Float32Grid {
  if (!breaksM.length) return grid;
  const sorted = [...breaksM].sort((a, b) => a - b);
  const data = new Float32Array(grid.data.length);
  for (let i = 0; i < grid.data.length; i++) {
    const z = grid.data[i];
    if (!Number.isFinite(z)) {
      data[i] = z;
      continue;
    }
    let bi = 0;
    while (bi < sorted.length - 1 && z > sorted[bi]) bi++;
    data[i] = sorted[bi];
  }
  return { ...grid, data };
}
