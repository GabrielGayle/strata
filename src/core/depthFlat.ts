// Background-to-plate-flat for IMAGE / depth-from-photo faces.
// Map faces (mapOrtho) skip this: they stay real metres × exaggeration.
// User-set values are only written when the user (or CLI) sets them; parsers
// and auto rebuilds call fillFlatDefaults, which never overwrites a present field.

import type { DepthData, DepthSettings } from './depth';

export const FLAT_LEVEL_MODES = ['off', 'auto', 'plateau', 'percentile', 'eyedropper'] as const;
export type FlatLevelMode = (typeof FLAT_LEVEL_MODES)[number];
export const ENGAGED_FLAT_MODES = ['auto', 'plateau', 'percentile', 'eyedropper'] as const;
export type EngagedFlatMode = (typeof ENGAGED_FLAT_MODES)[number];

export const DEFAULT_FLAT_PERCENTILE = 85;
export const DEFAULT_EDGE_EASE = 0;
export const DEFAULT_STEP_LIMIT = 0;

export function isMapDepthFace(d: Pick<DepthData, 'mapOrtho'>): boolean {
  return d.mapOrtho?.source === 'map';
}

export function isEngagedFlatMode(v: unknown): v is EngagedFlatMode {
  return v === 'auto' || v === 'plateau' || v === 'percentile' || v === 'eyedropper';
}

export function isFlatLevelMode(v: unknown): v is FlatLevelMode {
  return v === 'off' || isEngagedFlatMode(v);
}

/** Fill missing flat-level keys only. Present values (including 0 / false) stay put. */
export function fillFlatDefaults(s: DepthSettings): DepthSettings {
  return {
    ...s,
    ...(s.flatLevelMode === undefined ? {} : { flatLevelMode: s.flatLevelMode }),
    flatLevelOverride: s.flatLevelOverride === true,
    flatPercentile: s.flatPercentile ?? DEFAULT_FLAT_PERCENTILE,
    edgeEase: s.edgeEase ?? DEFAULT_EDGE_EASE,
    stepLimit: s.stepLimit ?? DEFAULT_STEP_LIMIT,
    flatNegative: s.flatNegative === true,
  };
}

/** Missing mode (legacy saves) and explicit Off both leave the depth map alone. */
export function isFlatEngaged(s: DepthSettings): boolean {
  if (s.flatLevelMode === 'off') return false;
  return isEngagedFlatMode(s.flatLevelMode) || s.flatLevelOverride === true;
}

/** Clear every flat-level field and land on Auto with factory extras. */
export function resetFlatToAuto(s: DepthSettings): DepthSettings {
  return {
    ...s,
    flatLevelMode: 'auto',
    flatLevelOverride: false,
    flatLevel: undefined,
    flatPercentile: DEFAULT_FLAT_PERCENTILE,
    edgeEase: DEFAULT_EDGE_EASE,
    stepLimit: DEFAULT_STEP_LIMIT,
    flatNegative: false,
  };
}

export function isFlatDirty(s: DepthSettings): boolean {
  const f = fillFlatDefaults(s);
  if (!isFlatEngaged(f)) return false;
  return (
    f.flatLevelOverride === true ||
    (f.edgeEase ?? 0) > 0 ||
    (f.stepLimit ?? 0) > 0 ||
    f.flatNegative === true ||
    (f.flatPercentile ?? DEFAULT_FLAT_PERCENTILE) !== DEFAULT_FLAT_PERCENTILE ||
    (isEngagedFlatMode(f.flatLevelMode) && f.flatLevelMode !== 'auto')
  );
}

function validMetres(metres: Float32Array): number[] {
  const out: number[] = [];
  for (const m of metres) if (m > 0 && Number.isFinite(m)) out.push(m);
  return out;
}

/**
 * Percentile of the sample depth *span* (min–max metres), not pixel count.
 * A photo backdrop is often most of the pixels, so a count-quantile at 60 and
 * 85 both sat on the same far wall (~38 mm plate) and the slider looked dead.
 * Walking the span makes 60 vs 85 different plates.
 */
export function percentileMetres(vals: number[], p: number): number {
  if (!vals.length) return NaN;
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of vals) {
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  if (!(hi > lo)) return lo;
  const t = Math.min(100, Math.max(0, p)) / 100;
  return lo + t * (hi - lo);
}

/** Near edge of the strongest far-ish histogram plateau (metres). */
export function plateauMetres(vals: number[], minM: number, maxM: number): number {
  if (!vals.length) return maxM;
  const bins = 48;
  const span = Math.max(1e-6, maxM - minM);
  const hist = new Float64Array(bins);
  for (const m of vals) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((m - minM) / span) * bins)));
    hist[i]++;
  }
  let peak = 0;
  for (const n of hist) if (n > peak) peak = n;
  if (peak < 1) return maxM;
  const thresh = peak * 0.45;
  let bestLen = 0;
  let bestStart = bins - 1;
  let bestMid = 0;
  let i = 0;
  while (i < bins) {
    if (hist[i] < thresh) {
      i++;
      continue;
    }
    let j = i;
    while (j < bins && hist[j] >= thresh) j++;
    const len = j - i;
    const mid = (i + j) / 2;
    if (len > bestLen || (len === bestLen && mid > bestMid)) {
      bestLen = len;
      bestStart = i;
      bestMid = mid;
    }
    i = j;
  }
  return minM + (bestStart / bins) * span;
}

/** Background level: far plateau when it is clearly behind the subject, else a high percentile. */
export function autoFlatLevel(vals: number[], minM: number, maxM: number, farM: number): number {
  if (!vals.length) return farM;
  const plat = plateauMetres(vals, minM, maxM);
  const t = (plat - minM) / Math.max(1e-6, maxM - minM);
  if (t >= 0.55) return plat;
  const p = percentileMetres(vals, 88);
  return Number.isFinite(p) ? p : farM;
}

export interface ResolvedFlatLevel {
  levelM: number;
  mode: FlatLevelMode;
  overridden: boolean;
}

export function resolveFlatLevel(
  metres: Float32Array,
  d: Pick<DepthData, 'minM' | 'maxM' | 'farM'>,
  s: DepthSettings,
): ResolvedFlatLevel {
  const filled = fillFlatDefaults(s);
  const overridden = filled.flatLevelOverride === true && Number.isFinite(filled.flatLevel);
  const rawMode = filled.flatLevelMode;
  const mode: FlatLevelMode = isFlatLevelMode(rawMode) ? rawMode : overridden ? 'auto' : 'off';
  if (overridden && mode !== 'off') {
    return { levelM: clampLevel(filled.flatLevel as number, d.minM, d.maxM), mode, overridden: true };
  }
  const vals = validMetres(metres);
  let levelM: number;
  if (mode === 'plateau') levelM = plateauMetres(vals, d.minM, d.maxM);
  else if (mode === 'percentile') levelM = percentileMetres(vals, filled.flatPercentile ?? DEFAULT_FLAT_PERCENTILE);
  else if (mode === 'eyedropper' && Number.isFinite(filled.flatLevel)) levelM = filled.flatLevel as number;
  else if (mode === 'auto') levelM = autoFlatLevel(vals, d.minM, d.maxM, d.farM);
  else levelM = d.farM;
  if (!Number.isFinite(levelM)) levelM = d.farM;
  return { levelM: clampLevel(levelM, d.minM, d.maxM), mode, overridden: false };
}

function clampLevel(m: number, lo: number, hi: number) {
  if (!(hi > lo)) return m;
  return Math.min(hi, Math.max(lo, m));
}

function smoothstep(a: number, b: number, x: number) {
  if (!(b > a)) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function heightOf(m: number, near: number, far: number, persp: boolean) {
  if (!(m > 0)) return 0;
  const v = persp ? 1 / m : -m;
  const hNear = persp ? 1 / near : -near;
  const hFar = persp ? 1 / far : -far;
  const den = hNear - hFar;
  if (!(Math.abs(den) > 1e-12)) return 0;
  return Math.min(1, Math.max(0, (v - hFar) / den));
}

export interface HeightMapOpts {
  near: number;
  far: number;
  persp: boolean;
}

/**
 * Flatten everything at or beyond `levelM` onto that plate. Edge ease is a
 * smooth falloff on the near side of the level. Flatten-negative floors any
 * remaining dips below the plate. Mutates `height` and `keep`.
 */
export function flattenBackgroundToPlate(
  height: Float32Array,
  keep: Float32Array,
  metres: Float32Array,
  levelM: number,
  s: DepthSettings,
  map: HeightMapOpts,
): void {
  const filled = fillFlatDefaults(s);
  const plateH = heightOf(levelM, map.near, map.far, map.persp);
  const span = Math.max(1e-6, map.far - map.near);
  const easeM = Math.max(0, filled.edgeEase ?? 0) * span;
  const n = height.length;
  for (let i = 0; i < n; i++) {
    const m = metres[i];
    const valid = m > 0 && Number.isFinite(m);
    if (valid) {
      let t = 0;
      if (m >= levelM) t = 1;
      else if (easeM > 0 && m > levelM - easeM) t = smoothstep(levelM - easeM, levelM, m);
      if (t > 0) {
        height[i] = height[i] * (1 - t) + plateH * t;
        keep[i] = Math.max(keep[i], t);
      }
    }
    // Floor dips under the plate (squash, holes with keep, nearer samples pulled down).
    if (filled.flatNegative && height[i] < plateH && (keep[i] > 0 || valid)) {
      height[i] = plateH;
      keep[i] = Math.max(keep[i], 1);
    }
  }
}

/** Cap |Δheight| between 4-connected neighbours (0–1 height units). */
export function limitHeightSteps(data: Float32Array, w: number, h: number, maxStep: number): Float32Array {
  if (!(maxStep > 0) || w < 1 || h < 1) return data;
  const out = data.slice();
  const relax = (i: number, j: number) => {
    const d = out[j] - out[i];
    const ad = Math.abs(d);
    if (ad <= maxStep) return false;
    const extra = (ad - maxStep) / 2;
    const s = d < 0 ? -1 : 1;
    out[i] += s * extra;
    out[j] -= s * extra;
    return true;
  };
  const passes = Math.min(256, Math.max(32, (w + h) * 4));
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x + 1 < w && relax(i, i + 1)) changed = true;
        if (y + 1 < h && relax(i, i + w)) changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Sample a metres buffer at normalised image coords (0..1). Null if no depth there. */
export function sampleMetresAt(metres: Float32Array, w: number, h: number, u: number, v: number): number | null {
  const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
  const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
  const m = metres[y * w + x];
  return m > 0 && Number.isFinite(m) ? m : null;
}

export interface FlatCliPatch {
  flatLevel?: number | FlatLevelMode;
  edgeEase?: number;
  stepLimit?: number;
  flatNegative?: boolean;
}

/** Apply CLI / UI patch. Sets the override flag when the user supplies a metre value. */
export function applyFlatCliPatch(settings: DepthSettings, patch: FlatCliPatch): DepthSettings {
  const next: DepthSettings = { ...settings };
  if (typeof patch.flatLevel === 'number' && Number.isFinite(patch.flatLevel)) {
    next.flatLevel = patch.flatLevel;
    next.flatLevelOverride = true;
    if (!isEngagedFlatMode(next.flatLevelMode)) next.flatLevelMode = 'auto';
  } else if (isFlatLevelMode(patch.flatLevel)) {
    if (patch.flatLevel === 'eyedropper') {
      throw new Error('--flat-level eyedropper needs a metre value; use --flat-level <metres>');
    }
    next.flatLevelMode = patch.flatLevel;
    if (patch.flatLevel === 'auto' || patch.flatLevel === 'off') next.flatLevelOverride = false;
  }
  if (patch.edgeEase != null && Number.isFinite(patch.edgeEase)) {
    next.edgeEase = Math.min(1, Math.max(0, patch.edgeEase));
    if (!isEngagedFlatMode(next.flatLevelMode)) next.flatLevelMode = 'auto';
  }
  if (patch.stepLimit != null && Number.isFinite(patch.stepLimit)) {
    next.stepLimit = Math.min(1, Math.max(0, patch.stepLimit));
    if (!isEngagedFlatMode(next.flatLevelMode)) next.flatLevelMode = 'auto';
  }
  if (patch.flatNegative != null) {
    next.flatNegative = patch.flatNegative;
    if (!isEngagedFlatMode(next.flatLevelMode)) next.flatLevelMode = 'auto';
  }
  return next;
}

export function parseFlatLevelFlag(raw: string): number | FlatLevelMode {
  const v = raw.trim().toLowerCase();
  if (isFlatLevelMode(v)) return v;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--flat-level expects a metre value or off|auto|plateau|percentile (got '${raw}')`);
  return n;
}

export function parse01Flag(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${flag} expects a number 0..1`);
  return Math.min(1, Math.max(0, n));
}

export function parseBoolFlag(raw: string | undefined, flag: string): boolean {
  if (raw == null || raw === '') return true;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  throw new Error(`${flag} expects on/off`);
}
