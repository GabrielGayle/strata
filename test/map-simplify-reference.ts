// The simplifier as it was before the map speed rewrite, kept as a reference for test/map-speed.test.ts.
import type { Float32Grid } from '../src/core/mapGrid';

interface MapSimplifyOptions {
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

interface MapSimplifyResult {
  grid: Float32Grid;
  /** Islands + holes removed. */
  lostFeatures: number;
}

function defaultMinArea(kerfMm: number, pixelSizeM: number): number {
  const kerfM = kerfMm / 1000;
  const kerfPx = Math.max(1, kerfM / Math.max(pixelSizeM, 1e-6));
  return Math.max(4, 3 * kerfPx * kerfPx);
}

function forEachComponent(
  mask: Uint8Array,
  w: number,
  h: number,
  on: 0 | 1,
  cb: (pixels: number[], area: number) => void,
) {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (seen[i] || mask[i] !== on) continue;
    const pixels: number[] = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (seen[n] || mask[n] !== on) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    cb(pixels, pixels.length);
  }
}

function neighborMean(data: Float32Array, w: number, h: number, x: number, y: number): number {
  let sum = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const v = data[ny * w + nx];
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
  }
  return n ? sum / n : data[y * w + x];
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const v = src[yy * w + xx];
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      }
      out[y * w + x] = n ? sum / n : src[y * w + x];
    }
  }
  return out;
}

/**
 * Remove small elevated islands and small depressions in the elevation field.
 */
export function simplifyMetricGridReference(grid: Float32Grid, opts: MapSimplifyOptions = {}): MapSimplifyResult {
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
      if (!Number.isFinite(z)) continue;
      const nb = neighborMean(data, w, h, x, y);
      if (z > nb + 0.25) peakMask[i] = 1;
      if (z < nb - 0.25) pitMask[i] = 1;
    }
  }

  const fillFromBorder = (pixels: number[]) => {
    const inComp = new Uint8Array(data.length);
    for (const p of pixels) inComp[p] = 1;
    let sum = 0;
    let n = 0;
    for (const p of pixels) {
      const x = p % w;
      const y = (p / w) | 0;
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (inComp[ni]) continue;
        const v = data[ni];
        if (Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
    }
    const fill = n ? sum / n : pixels.reduce((a, p) => a + data[p], 0) / pixels.length;
    for (const p of pixels) data[p] = fill;
  };

  forEachComponent(peakMask, w, h, 1, (pixels, area) => {
    if (area >= minIsland) return;
    lost++;
    fillFromBorder(pixels);
  });

  forEachComponent(pitMask, w, h, 1, (pixels, area) => {
    if (area >= minHole) return;
    lost++;
    fillFromBorder(pixels);
  });

  const sr = opts.smoothRadiusPx ?? 1;
  const out: Float32Array = sr > 0 ? boxBlur(data, w, h, sr) : data;
  return { grid: { ...grid, data: out }, lostFeatures: lost };
}

