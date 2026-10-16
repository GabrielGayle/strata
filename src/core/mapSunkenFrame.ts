// Sunken concrete-frame layout: plates step down into a cast surround (ticket T28).
import { offset, shapeArea, unionShapes, type Shape } from './geom2d';
import type { MouldPart, MouldResult } from './mould';
import type { SliceResult } from './slicer';
import type { MapSpec } from './mapSpec';

export const DEFAULT_FRAME_CAST_TOLERANCE_MM = 1.5;
export const DEFAULT_FRAME_WALL_MM = 25;
export const CONCRETE_DENSITY_KG_M3 = 2400;

export interface SunkenFrameOptions {
  castToleranceMm?: number;
  wallMm?: number;
}

export function sunkenFrameOptions(spec: Pick<MapSpec, 'sunkenFrame'>): SunkenFrameOptions {
  return {
    castToleranceMm: spec.sunkenFrame?.castToleranceMm ?? DEFAULT_FRAME_CAST_TOLERANCE_MM,
    wallMm: spec.sunkenFrame?.wallMm ?? DEFAULT_FRAME_WALL_MM,
  };
}

/** Build a pit-style frame mould from flat-stack plate outlines (reuses cast-edition ring logic). */
export function buildMapSunkenFrameMould(sliced: SliceResult, spec: Pick<MapSpec, 'sunkenFrame'>, thicknessMm: number): MouldResult {
  const opts = sunkenFrameOptions(spec);
  const plateParts = sliced.parts.filter((p) => p.kind === 'plate' && p.plateKey.startsWith('P'));
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
