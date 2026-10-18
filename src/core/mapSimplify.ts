// Auto-simplify map elevation grids: drop tiny islands/holes, light smooth (ticket 11).
import type { Float32Grid } from './mapGrid';
import { highestSummitCells, prominentSummitCells, type SummitCell } from './mapSummits';

export interface MapSimplifyOptions {
  /** Minimum feature area in square pixels (default ≈ 3×kerf² when kerf supplied). */
  minIslandAreaPx?: number;
  minHoleAreaPx?: number;
  /** Kerf in millimetres (used with pixel size to derive min areas). */
  kerfMm?: number;
  /** Ground metres per pixel (for kerf-derived defaults). */
  pixelSizeM?: number;
  /** Box-blur radius in pixels after cleanup (0 = off). */
  smoothRadiusPx?: number;
}

export interface MapSimplifyResult {
  grid: Float32Grid;
  /** Islands + holes removed. */
  lostFeatures: number;
}

function defaultMinArea(kerfMm: number, pixelSizeM: number): number {
  const kerfM = kerfMm / 1000;
  const kerfPx = Math.max(1, kerfM / Math.max(pixelSizeM, 1e-6));
  return Math.max(4, 3 * kerfPx * kerfPx);
}

/**
 * Visit each 4-connected component of `mask === on` in scan order. One label
 * array and one pixel buffer serve every component; `pixels` is only valid
 * for the duration of the callback.
 */
function forEachComponent(
  mask: Uint8Array,
  w: number,
  h: number,
  on: 0 | 1,
  cb: (pixels: Int32Array, area: number, label: Int32Array, id: number) => void,
) {
  const label = new Int32Array(mask.length);
  const buf = new Int32Array(mask.length);
  let id = 0;
  for (let i = 0; i < mask.length; i++) {
    if (label[i] || mask[i] !== on) continue;
    id++;
    // `buf` doubles as the flood stack: [0, read) are done, [read, len) are queued.
    let len = 0;
    buf[len++] = i;
    label[i] = id;
    for (let read = 0; read < len; read++) {
      const p = buf[read];
      const x = p % w;
      if (x > 0 && !label[p - 1] && mask[p - 1] === on) {
        label[p - 1] = id;
        buf[len++] = p - 1;
      }
      if (x < w - 1 && !label[p + 1] && mask[p + 1] === on) {
        label[p + 1] = id;
        buf[len++] = p + 1;
      }
      if (p >= w && !label[p - w] && mask[p - w] === on) {
        label[p - w] = id;
        buf[len++] = p - w;
      }
      if (p + w < h * w && !label[p + w] && mask[p + w] === on) {
        label[p + w] = id;
        buf[len++] = p + w;
      }
    }
    cb(buf.subarray(0, len), len, label, id);
  }
}

function isFiniteNum(v: number): boolean {
  return v === v && v !== Infinity && v !== -Infinity;
}

function neighborMean(data: Float32Array, w: number, h: number, x: number, y: number): number {
  let sum = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const v = data[ny * w + nx];
      if (isFiniteNum(v)) {
        sum += v;
        n++;
      }
    }
  }
  return n ? sum / n : data[y * w + x];
}

/**
 * Mean of the finite cells in a (2r+1)² window, edges clamped. Separable:
 * finite sums and counts run along rows, then down columns.
 */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  const rowSum = new Float64Array(src.length);
  const rowCount = new Float64Array(src.length);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dx = -r; dx <= r; dx++) {
        const v = src[base + Math.min(w - 1, Math.max(0, x + dx))];
        if (isFiniteNum(v)) {
          sum += v;
          n++;
        }
      }
      rowSum[base + x] = sum;
      rowCount[base + x] = n;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const j = Math.min(h - 1, Math.max(0, y + dy)) * w + x;
        sum += rowSum[j];
        n += rowCount[j];
      }
      out[y * w + x] = n ? sum / n : src[y * w + x];
    }
  }
  return out;
}

/**
 * Remove small elevated islands and small depressions in the elevation field.
 */
export function simplifyMetricGrid(grid: Float32Grid, opts: MapSimplifyOptions = {}): MapSimplifyResult {
  const pixelSizeM = Math.abs(opts.pixelSizeM ?? grid.transform.pixelW);
  const kerf = opts.kerfMm ?? 0.2;
  const minIsland = opts.minIslandAreaPx ?? defaultMinArea(kerf, pixelSizeM);
  const minHole = opts.minHoleAreaPx ?? minIsland;
  const { w, h, data: src } = grid;
  const data = new Float32Array(src);
  let lost = 0;

  const peakMask = new Uint8Array(data.length);
  const pitMask = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z = data[i];
      if (!isFiniteNum(z)) continue;
      const nb = neighborMean(data, w, h, x, y);
      if (z > nb + 0.25) peakMask[i] = 1;
      if (z < nb - 0.25) pitMask[i] = 1;
    }
  }

  /** Fill a component with the mean of its finite 4-neighbours outside it (border cells counted once per contact). */
  const fillFromBorder = (pixels: Int32Array, label: Int32Array, id: number) => {
    let sum = 0;
    let n = 0;
    const visit = (ni: number) => {
      if (label[ni] === id) return;
      const v = data[ni];
      if (isFiniteNum(v)) {
        sum += v;
        n++;
      }
    };
    for (let k = 0; k < pixels.length; k++) {
      const p = pixels[k];
      const x = p % w;
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p + w < h * w) visit(p + w);
    }
    let fill: number;
    if (n) fill = sum / n;
    else {
      let total = 0;
      for (let k = 0; k < pixels.length; k++) total += data[pixels[k]];
      fill = total / pixels.length;
    }
    for (let k = 0; k < pixels.length; k++) data[pixels[k]] = fill;
  };

  forEachComponent(peakMask, w, h, 1, (pixels, area, label, id) => {
    if (area >= minIsland) return;
    lost++;
    fillFromBorder(pixels, label, id);
  });

  forEachComponent(pitMask, w, h, 1, (pixels, area, label, id) => {
    if (area >= minHole) return;
    lost++;
    fillFromBorder(pixels, label, id);
  });

  const sr = opts.smoothRadiusPx ?? 1;
  const out: Float32Array = sr > 0 ? boxBlur(data, w, h, sr) : data;
  return { grid: { ...grid, data: out }, lostFeatures: lost };
}

/**
 * After island-fill / box-blur, put the DEM-max cell back so the true summit
 * survives simplify. Pass peaks from the continuous (pre-snap) grid so
 * plateau rims are not restored. Distinct peaks are Jenks pins.
 */
export function restoreSummitCells(
  simplified: Float32Grid,
  snapped: Float32Grid,
  peaks?: SummitCell[],
): Float32Grid {
  if (simplified.w !== snapped.w || simplified.h !== snapped.h || simplified.data.length !== snapped.data.length) {
    return simplified;
  }
  const cells = highestSummitCells(peaks ?? prominentSummitCells(snapped));
  if (!cells.length) return simplified;
  const data = new Float32Array(simplified.data);
  const src = snapped.data;
  for (const p of cells) {
    const want = src[p.i];
    if (Number.isFinite(want)) data[p.i] = want;
  }
  return { ...simplified, data };
}

/** Verify no on-mask component is smaller than minArea (post-simplify QA). */
export function smallestComponentArea(mask: Uint8Array, w: number, h: number, on: 0 | 1): number {
  let min = Infinity;
  forEachComponent(mask, w, h, on, (_pixels, area) => {
    if (area < min) min = area;
  });
  return min === Infinity ? 0 : min;
}
