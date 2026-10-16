// Metric depth → plate proportions: pinhole back-projection, robust extents, master-size fit.
import type { DepthData } from './depth';
import { decodeDepthBuffers } from './depth';
import { evaluateParams, PARAM_MAP, type RawValue, type Values } from './params';

export type DepthFace = 'top' | 'front' | 'side';

export const DEFAULT_HFOV_DEG = 60;
export const PERSPECTIVE_NOTE =
  'Extents come from Depth Pro’s perspective depth map (pinhole back-projection), not an orthographic flattening — distant features are compressed like in the photo.';

export type FocalSource = 'depthPro' | 'exif' | 'fov60';

export interface DepthExtent {
  widthM: number;
  heightM: number;
  deltaZM: number;
  aspectWH: number;
  reliefToWidth: number;
  focalPx: number;
  focalSource: FocalSource;
  sampleCount: number;
}

export interface AutoDimensionOptions {
  reliefExaggeration?: number;
  /** Principal point as fractions of width/height (default 0.5, 0.5). */
  cx?: number;
  cy?: number;
  /** Ignore depth farther than this (metres); defaults to depth.farM. */
  depthCeilingM?: number;
  useMatte?: boolean;
}

export interface ParamDiffLine {
  id: string;
  label: string;
  before: string;
  after: string;
  clamped?: boolean;
}

export interface AutoDimensionPreview {
  extent: DepthExtent;
  readout: string;
  patch: Record<string, RawValue>;
  diff: ParamDiffLine[];
  clamped: string[];
  note: string;
  /** False when depth is missing or too few samples. */
  ok: boolean;
  reason?: string;
}

export function focalLengthPx(depth: Pick<DepthData, 'w' | 'h' | 'focalLengthPx' | 'exifFocalLengthPx'>): { f: number; source: FocalSource } {
  if (depth.focalLengthPx != null && depth.focalLengthPx > 0) return { f: depth.focalLengthPx, source: 'depthPro' };
  if (depth.exifFocalLengthPx != null && depth.exifFocalLengthPx > 0) return { f: depth.exifFocalLengthPx, source: 'exif' };
  const f = depth.w / (2 * Math.tan((DEFAULT_HFOV_DEG * Math.PI) / 360));
  return { f, source: 'fov60' };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const t = (sorted.length - 1) * p;
  const lo = Math.floor(t);
  const hi = Math.ceil(t);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (t - lo);
}

/** Pinhole back-projection and 2–98% ROI extents in metres. */
export function measureDepthExtent(depth: DepthData, opts: AutoDimensionOptions = {}): DepthExtent | null {
  const { metres, mask } = decodeDepthBuffers(depth);
  const { f, source } = focalLengthPx(depth);
  const w = depth.w;
  const h = depth.h;
  const cx = (opts.cx ?? 0.5) * w;
  const cy = (opts.cy ?? 0.5) * h;
  const ceiling = opts.depthCeilingM ?? depth.farM ?? depth.maxM;
  const useMatte = opts.useMatte ?? true;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = v * w + u;
      const z = metres[i];
      if (!(z > 0) || z > ceiling) continue;
      if (useMatte && mask && mask[i] < 0.5) continue;
      const X = ((u - cx) * z) / f;
      const Y = ((v - cy) * z) / f;
      xs.push(X);
      ys.push(Y);
      zs.push(z);
    }
  }
  if (xs.length < 16) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const x0 = percentile(xs, 0.02);
  const x1 = percentile(xs, 0.98);
  const y0 = percentile(ys, 0.02);
  const y1 = percentile(ys, 0.98);
  const z0 = percentile(zs, 0.02);
  const z1 = percentile(zs, 0.98);
  const widthM = Math.max(1e-6, x1 - x0);
  const heightM = Math.max(1e-6, y1 - y0);
  const deltaZM = Math.max(1e-6, z1 - z0);
  const aspectWH = widthM / heightM;
  const reliefToWidth = deltaZM / widthM;
  return {
    widthM,
    heightM,
    deltaZM,
    aspectWH,
    reliefToWidth,
    focalPx: f,
    focalSource: source,
    sampleCount: xs.length,
  };
}

function formatMetres(m: number): string {
  if (m < 1) return `${Math.round(m * 100)} cm`;
  if (m < 10) return `${m.toFixed(2)} m`;
  return `${m.toFixed(1)} m`;
}

export function formatExtentReadout(e: DepthExtent): string {
  const w = formatMetres(e.widthM);
  const dep = formatMetres(e.deltaZM);
  const ratio = e.reliefToWidth > 0 ? `1:${(1 / e.reliefToWidth).toFixed(1)}` : '';
  return `~${w} wide, ${dep} relief range, ${ratio}`;
}

function rotSwap(deg: number): boolean {
  return ((Math.round(deg / 90) % 2) + 2) % 2 === 1;
}

function imageAspectForFace(face: DepthFace, extent: DepthExtent, v: Values): number {
  let w = extent.widthM;
  let h = extent.heightM;
  const rot = Number(v.imgRotate ?? 0);
  if (face === 'top') {
    const topRot = Number(v.topRotate ?? 0);
    if (rotSwap(rot + topRot)) [w, h] = [h, w];
    return w / h;
  }
  if (rotSwap(rot)) [w, h] = [h, w];
  if (face === 'side' && v.imgSideMode === 'silhouette') return w / h;
  if (face === 'side') return w / h; // image u along stack
  return w / h;
}

function reliefMm(extent: DepthExtent, referenceMm: number, exaggeration: number): number {
  const lateralM = Math.max(extent.widthM, extent.heightM);
  return (extent.deltaZM / lateralM) * referenceMm * exaggeration;
}

function clampNum(id: string, val: number): { v: number; clamped: boolean } {
  const d = PARAM_MAP[id];
  if (!d || d.kind !== 'number') return { v: val, clamped: false };
  let v = val;
  if (d.int) v = Math.round(v);
  const lo = d.min ?? -Infinity;
  const hi = d.max ?? Infinity;
  const clamped = v < lo || v > hi;
  return { v: Math.min(hi, Math.max(lo, v)), clamped };
}

function strVal(v: Values, id: string): string {
  const x = v[id];
  return typeof x === 'boolean' ? String(x) : String(x ?? '');
}

function diffLine(id: string, before: string, after: string, clamped?: boolean): ParamDiffLine {
  const d = PARAM_MAP[id];
  return { id, label: d?.label ?? id, before, after, clamped };
}

/**
 * Build parameter patch and diff for one face, fitting aspect to the current master outline
 * (long edge kept) and relief from metric depth.
 */
export function previewAutoDimension(
  face: DepthFace,
  depth: DepthData | undefined,
  raw: Record<string, RawValue>,
  opts: AutoDimensionOptions = {},
): AutoDimensionPreview {
  const note = PERSPECTIVE_NOTE;
  if (!depth) {
    return { extent: null as unknown as DepthExtent, readout: '', patch: {}, diff: [], clamped: [], note, ok: false, reason: 'No metric depth on this image' };
  }
  const extent = measureDepthExtent(depth, opts);
  if (!extent) {
    return { extent: null as unknown as DepthExtent, readout: '', patch: {}, diff: [], clamped: [], note, ok: false, reason: 'Too few depth samples (need a subject mask or nearer depth)' };
  }
  const exaggeration = opts.reliefExaggeration ?? 1;
  const ev = evaluateParams(raw);
  const v = ev.values;
  const readout = formatExtentReadout(extent);
  const patch: Record<string, RawValue> = {};
  const diff: ParamDiffLine[] = [];
  const clamped: string[] = [];

  const alongWidth = v.sliceMode !== 'radial' && v.sliceAxis === 'width';
  const runKey = alongWidth ? 'baseWidth' : 'baseLength';
  const acrossKey = alongWidth ? 'baseLength' : 'baseWidth';
  const runMm = v[runKey as keyof Values] as number;
  const acrossMm = v[acrossKey as keyof Values] as number;
  const longMm = Math.max(runMm, acrossMm);
  const aspect = imageAspectForFace(face, extent, v);

  const setNum = (id: string, val: number) => {
    const { v: clampedVal, clamped: was } = clampNum(id, val);
    if (was) clamped.push(id);
    const before = strVal(v, id);
    patch[id] = String(clampedVal);
    if (before !== String(clampedVal)) diff.push(diffLine(id, before, String(clampedVal), was));
  };

  const refMm = longMm;
  const relief = reliefMm(extent, refMm, exaggeration);

  if (face === 'top') {
    if (v.imgTopMode === 'off') patch.imgTopMode = 'carve';
    patch.imgFit = 'width';
    const newAcross = runMm * aspect;
    setNum(acrossKey, newAcross);
    setNum('topDepth', relief);
  } else if (face === 'front') {
    if (v.sliceMode !== 'parallel') {
      return { extent, readout, patch: {}, diff: [], clamped: [], note, ok: false, reason: 'Front auto-dimension needs a parallel stack' };
    }
    if (v.imgFrontMode === 'off') patch.imgFrontMode = 'layers';
    patch.imgFrontFit = 'width';
    const plateInner = v.stackHeight - 2 * v.frontMargin;
    const newAcross = plateInner * aspect + 2 * v.frontMargin + 2 * v.sideMargin;
    setNum(acrossKey, newAcross);
    const plates = clampNum('frontDepth', Math.max(1, Math.round(relief / Math.max(0.5, v.thickness))));
    if (plates.clamped) clamped.push('frontDepth');
    setNum('frontDepth', plates.v);
  } else {
    if (v.stackSource !== 'strata') {
      return { extent, readout, patch: {}, diff: [], clamped: [], note, ok: false, reason: 'Side auto-dimension needs strata stack source' };
    }
    if (v.imgSideMode === 'off') patch.imgSideMode = 'heightmap';
    patch.imgSideFit = 'length';
    if (v.spacingMode === 'fit') {
      patch.spacingMode = 'gap';
      patch.plateGap = String(Math.max(0.5, Math.round((v.pitch - v.thickness) * 2) / 2));
    }
    const newRun = acrossMm * aspect;
    setNum(runKey, newRun);
    setNum('imgRange', relief);
  }

  for (const [id, val] of Object.entries(patch)) {
    if (PARAM_MAP[id]?.kind === 'choice' || PARAM_MAP[id]?.kind === 'toggle') {
      const before = String(raw[id] ?? PARAM_MAP[id]?.def ?? '');
      if (before !== String(val)) diff.push(diffLine(id, before, String(val)));
    }
  }

  return { extent, readout, patch, diff, clamped, note, ok: true };
}

export function applyAutoDimensionPatch(raw: Record<string, RawValue>, preview: AutoDimensionPreview): Record<string, RawValue> {
  if (!preview.ok) return raw;
  return { ...raw, ...preview.patch };
}
