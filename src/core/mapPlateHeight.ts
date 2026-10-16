// Map faces: real elevation (metres) × exaggeration → plate heights (mm).
// Bypasses the photo/image pipeline (mix, contrast, blur, flatten, flat level).
import type { DepthData } from './depth';
import { decodeDepthBuffers } from './depth';
import type { Gray } from './image';
import type { HeightField } from './heightfield';
import { stackFrame } from './heightfield';
import type { Values } from './params';

/** Lowest plate top (mm above the concrete line) so outlines stay valid. */
export const MAP_HEIGHT_FLOOR_MM = 4;

export function isMapDepth(depth: DepthData | undefined): depth is DepthData & { mapOrtho: NonNullable<DepthData['mapOrtho']> } {
  return !!depth?.mapOrtho && depth.mapOrtho.source === 'map';
}

/** Plan scale: millimetres of model per metre of ground. */
export function mapScaleMmPerM(mapWidthM: number, masterWidthMm: number): number {
  if (!(mapWidthM > 0) || !(masterWidthMm > 0)) return 0;
  return masterWidthMm / mapWidthM;
}

/** True relief (m) × exaggeration, converted to millimetres at the map's plan scale. */
export function mapReliefToPlateRangeMm(reliefM: number, exaggeration: number, scaleMmPerM: number): number {
  return Math.max(0, reliefM) * Math.max(0, exaggeration) * Math.max(0, scaleMmPerM);
}

export function mapMasterWidthMm(v: Values): number {
  return Math.max(Number(v.baseLength) || 0, Number(v.baseWidth) || 0);
}

/** True (max−min m) × exaggeration, scaled to mm at the current master outline. */
export function mapTrueRangePlateMm(depth: DepthData, v: Values, exaggeration: number): number {
  const ortho = depth.mapOrtho;
  if (!ortho) return 0;
  const scale = mapScaleMmPerM(ortho.widthM, mapMasterWidthMm(v));
  return mapReliefToPlateRangeMm(ortho.reliefM, exaggeration, scale);
}

/** Plate-height span from the current near/far window (encoded metres already include exaggeration). */
export function mapExpectedPlateRangeMm(depth: DepthData, v: Values): number {
  const ortho = depth.mapOrtho;
  if (!ortho) return 0;
  const near = Math.max(1e-6, Math.min(depth.settings.near, depth.settings.far - 1e-6));
  const far = Math.max(near + 1e-6, depth.settings.far);
  const scale = mapScaleMmPerM(ortho.widthM, mapMasterWidthMm(v));
  return (far - near) * scale;
}

/**
 * Linear grey from map depth: near (high ground) = dark.
 * Ignores flatten, curve, perspective, and matte.
 */
export function mapDepthToGray(d: DepthData): Gray {
  const { metres } = decodeDepthBuffers(d);
  const n = d.w * d.h;
  const near = Math.max(1e-6, Math.min(d.settings.near, d.settings.far - 1e-6));
  const far = Math.max(near + 1e-6, d.settings.far);
  const data = new Float32Array(n);
  const span = far - near;
  for (let i = 0; i < n; i++) {
    const m = metres[i];
    if (!Number.isFinite(m)) {
      data[i] = 1;
      continue;
    }
    const t = Math.min(1, Math.max(0, (m - near) / span));
    data[i] = d.settings.invert ? 1 - t : t;
  }
  return { w: d.w, h: d.h, data };
}

function sampleMetres(metres: Float32Array, w: number, h: number, u: number, v: number): number {
  const x = Math.min(w - 1, Math.max(0, u * (w - 1)));
  const y = Math.min(h - 1, Math.max(0, v * (h - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix: number, iy: number) => metres[iy * w + ix];
  const lerp = (a: number, b: number, t: number) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * t : Number.isFinite(a) ? a : b);
  const a = lerp(at(x0, y0), at(x1, y0), tx);
  const b = lerp(at(x0, y1), at(x1, y1), tx);
  return lerp(a, b, ty);
}

/**
 * Plate-top height field from metric map depth.
 * Ignores mix, contrast, blur, flatten, curve, perspective, matte, and strata erosion.
 * User near/far window the elevation; linear in metres.
 */
export function buildMapHeightField(v: Values, depth: DepthData): HeightField {
  const { metres } = decodeDepthBuffers(depth);
  const ortho = depth.mapOrtho;
  const masterMm = mapMasterWidthMm(v);
  const mapM = Math.max(ortho?.widthM ?? 0, 1);
  const scale = mapScaleMmPerM(mapM, masterMm);
  const near = Math.max(1e-6, Math.min(depth.settings.near, depth.settings.far - 1e-6));
  const far = Math.max(near + 1e-6, depth.settings.far);
  const f = stackFrame(v);

  const at = (x: number, z: number) => {
    const s = x * f.stack[0] + z * f.stack[1];
    const a = x * f.across[0] + z * f.across[1];
    const sn = s / f.stackLen + 0.5;
    const an = a / f.acrossLen + 0.5;
    const d = sampleMetres(metres, depth.w, depth.h, an, 1 - sn);
    const dd = Number.isFinite(d) ? Math.min(far, Math.max(near, d)) : far;
    return MAP_HEIGHT_FLOOR_MM + (far - dd) * scale;
  };

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= 24; i++) {
    for (let j = 0; j <= 12; j++) {
      const s = (i / 24 - 0.5) * f.stackLen;
      const ac = (j / 12 - 0.5) * f.acrossLen;
      const h = at(s * f.stack[0] + ac * f.across[0], s * f.stack[1] + ac * f.across[1]);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  return { at, min, max };
}
