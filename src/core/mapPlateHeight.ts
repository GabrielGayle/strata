// Map faces: real elevation (metres) × exaggeration → plate heights (mm).
// Bypasses the photo/image pipeline (mix, contrast, blur, flatten, flat level).
import type { DepthData } from './depth';
import { decodeDepthBuffers } from './depth';
import type { Gray } from './image';
import type { HeightField } from './heightfield';
import { stackFrame } from './heightfield';
import type { Values } from './params';
import type { Plane } from './section';

/**
 * Physical map frame — right-handed, matching ENU (South × Up = West):
 *
 *   +X = south   S-01 / Front sits at −X = north
 *   +Y = up
 *   +Z = west    east is −Z
 *
 * Grid (Map preview, DEM): row 0 = north, col 0 = west, east on the right.
 * 3D Top (north up, camera up = −X): screen-right = −Z = east.
 * 3D Front (from north looking south) and each plate DXF viewed face-on from
 * the north: east on the left. Plate +u is +Z (west) so part minX is east.
 * OSM engrave uses that same plate +x. Do not roll the camera to fake E–W.
 */
export const MAP_WORLD_EAST_SIGN_Z = -1;

/** col01: 0 = west … 1 = east. row01: 0 = north … 1 = south. */
export function mapGridUvToWorld(v: Values, col01: number, row01: number): { x: number; z: number } {
  const f = stackFrame(v);
  const s = (row01 - 0.5) * f.stackLen;
  const a = (0.5 - col01) * f.acrossLen;
  return {
    x: s * f.stack[0] + a * f.across[0],
    z: s * f.stack[1] + a * f.across[1],
  };
}

/** 3D Top looking down −Y with camera up = −X (north). Screen-right = −Z = east. */
export function mapTopProject(x: number, z: number): { right: number; up: number } {
  return { right: -z, up: -x };
}

/** Flip plate +u so a north-facing DXF has east on the left (+u = west = +Z). */
export function orientMapPlatePlane(plane: Plane): Plane {
  if (Math.abs(plane.normal[1]) > 0.5) return plane;
  const u = plane.u;
  return { ...plane, u: [-u[0], -u[1], -u[2]] };
}

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
export function buildMapHeightField(v: Values, depth: DepthData, opts: { capMm?: number } = {}): HeightField {
  const { metres } = decodeDepthBuffers(depth);
  const ortho = depth.mapOrtho;
  const masterMm = mapMasterWidthMm(v);
  const mapM = Math.max(ortho?.widthM ?? 0, 1);
  const scale = mapScaleMmPerM(mapM, masterMm);
  const near = Math.max(1e-6, Math.min(depth.settings.near, depth.settings.far - 1e-6));
  const far = Math.max(near + 1e-6, depth.settings.far);
  const f = stackFrame(v);
  const reliefMm = Math.max(0, far - near) * scale;
  const unscaledMax = MAP_HEIGHT_FLOOR_MM + reliefMm;
  const capMm = v.sliceMode === 'flat' ? Infinity : opts.capMm;
  let heightCapScale = 1;
  if (capMm != null && Number.isFinite(capMm) && capMm > MAP_HEIGHT_FLOOR_MM && unscaledMax > capMm + 1e-6 && reliefMm > 0) {
    heightCapScale = (capMm - MAP_HEIGHT_FLOOR_MM) / reliefMm;
  }
  const mmPerEncodedM = scale * heightCapScale;

  const at = (x: number, z: number) => {
    const s = x * f.stack[0] + z * f.stack[1];
    const a = x * f.across[0] + z * f.across[1];
    const sn = s / f.stackLen + 0.5;
    const an = a / f.acrossLen + 0.5;
    // +across / +Z is west; geographic easting on the north-up grid is 1 − an.
    const d = sampleMetres(metres, depth.w, depth.h, 1 - an, sn);
    const dd = Number.isFinite(d) ? Math.min(far, Math.max(near, d)) : far;
    return MAP_HEIGHT_FLOOR_MM + (far - dd) * mmPerEncodedM;
  };

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < metres.length; i++) {
    const d = metres[i];
    if (!Number.isFinite(d)) continue;
    const dd = Math.min(far, Math.max(near, d));
    const h = MAP_HEIGHT_FLOOR_MM + (far - dd) * mmPerEncodedM;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  if (!Number.isFinite(min)) {
    min = MAP_HEIGHT_FLOOR_MM;
    max = MAP_HEIGHT_FLOOR_MM;
  }
  return {
    at,
    min,
    max,
    ...(heightCapScale < 1 - 1e-9 ? { heightCapScale } : {}),
  };
}

/**
 * Sample plate-top heights onto a north-up map grid (row 0 = north = S-01).
 * Used to correlate the 3D mesh with the metric DEM.
 */
export function sampleMapHeightGrid(hf: HeightField, v: Values, w: number, h: number): Float32Array {
  const data = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const sn = h <= 1 ? 0 : row / (h - 1);
    for (let col = 0; col < w; col++) {
      const an = w <= 1 ? 0 : col / (w - 1);
      const { x, z } = mapGridUvToWorld(v, an, sn);
      data[row * w + col] = hf.at(x, z);
    }
  }
  return data;
}
