// Sunken concrete-frame layout: plates step down into a cast surround (ticket T28).
import { difference, offset, shapeArea, unionShapes, type Shape } from './geom2d';
import type { MouldPart, MouldResult } from './mould';
import type { Part, SliceResult } from './slicer';
import type { MapSpec } from './mapSpec';

export const DEFAULT_FRAME_CAST_TOLERANCE_MM = 1.5;
export const DEFAULT_FRAME_WALL_MM = 25;
export const CONCRETE_DENSITY_KG_M3 = 2400;

export interface SunkenFrameOptions {
  castToleranceMm?: number;
  wallMm?: number;
}

/** Finished concrete tub the flat-stack plates sit in (3D base + STL). */
export interface SunkenFrameLayout {
  /** Plan of the concrete outer (x, −z). */
  outer: Shape;
  /** Pit the plates sit in. */
  cavity: Shape;
  /** Wall ring (outer minus cavity). */
  ring: Shape;
  floorMm: number;
  /** Top of the concrete rim (includes a lip above the stack). */
  rimY: number;
  /** Add this to sliced plate world Y so layer 0 sits on the floor. */
  plateLiftMm: number;
  wallMm: number;
  layerCount: number;
}

export function sunkenFrameOptions(spec: Pick<MapSpec, 'sunkenFrame'>): SunkenFrameOptions {
  return {
    castToleranceMm: spec.sunkenFrame?.castToleranceMm ?? DEFAULT_FRAME_CAST_TOLERANCE_MM,
    wallMm: spec.sunkenFrame?.wallMm ?? DEFAULT_FRAME_WALL_MM,
  };
}

/** T28 pit is a flat-stack tub. Upright slats (Vermilion, waffle, radial) have no per-depth seats. */
export function sunkenFrameApplies(sliceMode: string): boolean {
  return sliceMode === 'flat';
}

export const SUNKEN_FRAME_FLAT_ONLY_HINT =
  'Sunken concrete frame is for the Stamped stack (flat layers). Upright slat designs such as Vermilion have no pit — plates stand in the base.';

export const SUNKEN_FRAME_FLAT_HINT =
  'Cast concrete pit the flat layers sit in. Plates step down into the surround.';


/** Flat-stack layers are family P with keys L0, L1, …; upright plates use P0, P1, …. */
export function framePlateParts(sliced: SliceResult): Part[] {
  return sliced.parts.filter((p) => p.kind === 'plate' && p.family === 'P');
}

function layerCount(plates: Part[]): number {
  const ids = new Set(plates.map((p) => p.index));
  return ids.size || plates.length;
}

/**
 * Pit-style concrete surround from flat-stack plate outlines.
 * `plateBaseY` is the world Y of the bottom of layer 0 as sliced (usually `baseTop`).
 * `extraOuter` is unioned in so a sized base plan still forms the outer wall.
 */
export function buildMapSunkenFrameLayout(
  sliced: SliceResult,
  spec: Pick<MapSpec, 'sunkenFrame'>,
  thicknessMm: number,
  plateBaseY: number,
  extraOuter?: Shape,
): SunkenFrameLayout | null {
  if (!spec.sunkenFrame?.enabled) return null;
  const plates = framePlateParts(sliced);
  const shapes = plates.filter((p) => p.shape?.length).map((p) => p.shape);
  if (!shapes.length) return null;
  const opts = sunkenFrameOptions(spec);
  const wall = opts.wallMm ?? DEFAULT_FRAME_WALL_MM;
  const tol = opts.castToleranceMm ?? DEFAULT_FRAME_CAST_TOLERANCE_MM;
  const footprint = unionShapes(...shapes);
  if (!footprint.length) return null;
  const cavity = tol > 0 ? offset(footprint, tol) : footprint;
  if (!cavity.length) return null;
  const grown = offset(cavity, wall);
  const outer = extraOuter?.length ? unionShapes(grown, extraOuter) : grown;
  if (!outer.length) return null;
  const ring = difference(outer, cavity);
  if (!ring.length) return null;
  const n = layerCount(plates);
  const stackMm = Math.max(thicknessMm, thicknessMm * n);
  const floorMm = wall;
  const lipMm = wall;
  const rimY = floorMm + stackMm + lipMm;
  return {
    outer,
    cavity,
    ring,
    floorMm,
    rimY,
    plateLiftMm: floorMm - plateBaseY,
    wallMm: wall,
    layerCount: n,
  };
}

/** Build a pit-style frame mould from flat-stack plate outlines (reuses cast-edition ring logic). */
export function buildMapSunkenFrameMould(sliced: SliceResult, spec: Pick<MapSpec, 'sunkenFrame'>, thicknessMm: number): MouldResult {
  const opts = sunkenFrameOptions(spec);
  const plateParts = framePlateParts(sliced);
  if (!plateParts.length) return { parts: [], notes: ['No plates for sunken frame.'], dowels: 0, bolts: 0 };
  const shapes: Shape[] = [];
  const seats: string[] = [];
  for (let i = 0; i < plateParts.length; i++) {
    const p = plateParts[i];
    const depthMm = i * thicknessMm;
    seats.push(`${p.plateKey} seat at ${depthMm.toFixed(1)} mm below rim (±${opts.castToleranceMm} mm cast tolerance)`);
    if (p.shape?.length) shapes.push(p.shape);
  }
  const footprint = shapes.length ? unionShapes(...shapes) : [];
  const wall = opts.wallMm ?? DEFAULT_FRAME_WALL_MM;
  const outer = footprint.length ? offset(footprint, wall) : [];
  const parts: MouldPart[] = [];
  if (outer.length) {
    parts.push({
      id: 'MF-outer',
      body: 'base',
      kind: 'ring',
      shape: outer,
      y0: 0,
      thickness: thicknessMm * plateParts.length + wall,
      area: shapeArea(outer),
    });
  }
  const volumeM3 = (parts[0]?.area ?? 0) * (parts[0]?.thickness ?? 0) / 1e9;
  const weightKg = volumeM3 * CONCRETE_DENSITY_KG_M3;
  const notes = [
    'Sunken concrete frame: plates lie flat and step down into the cast surround.',
    ...seats,
    `Estimated cast concrete (frame only): ~${weightKg.toFixed(1)} kg at ${CONCRETE_DENSITY_KG_M3} kg/m³.`,
  ];
  return { parts, notes, dowels: 0, bolts: 0 };
}
