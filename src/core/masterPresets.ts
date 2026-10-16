import { evaluateParams, type RawValue } from './params';

/** Portrait: shorter side is baseWidth; longer is baseLength (stack footprint). */
export type MasterOrientation = 'portrait' | 'landscape';

export type MasterPresetId =
  | 'iphone17'
  | 'a3'
  | 'a4'
  | 'a5'
  | 'a6'
  | 'ratio16x9'
  | 'ratio4x3'
  | 'ratio1x1'
  | 'ratio3x2';

export interface MasterPresetOption {
  id: MasterPresetId;
  label: string;
  kind: 'fixed' | 'ratio';
}

export const MASTER_PRESET_OPTIONS: MasterPresetOption[] = [
  { id: 'iphone17', label: 'iPhone 17', kind: 'fixed' },
  { id: 'a3', label: 'A3', kind: 'fixed' },
  { id: 'a4', label: 'A4', kind: 'fixed' },
  { id: 'a5', label: 'A5', kind: 'fixed' },
  { id: 'a6', label: 'A6', kind: 'fixed' },
  { id: 'ratio16x9', label: '16:9', kind: 'ratio' },
  { id: 'ratio4x3', label: '4:3', kind: 'ratio' },
  { id: 'ratio1x1', label: '1:1 square', kind: 'ratio' },
  { id: 'ratio3x2', label: '3:2', kind: 'ratio' },
];

export type FixedMasterPresetId = 'iphone17' | 'a3' | 'a4' | 'a5' | 'a6';

/** ISO 216 and phone footprints: shorter × longer side in mm (portrait). */
export const FIXED_OUTLINE_MM: Record<FixedMasterPresetId, { short: number; long: number }> = {
  // Apple iPhone 17 — https://www.apple.com/iphone-17/specs/ (71.5 mm × 149.6 mm)
  iphone17: { short: 71.5, long: 149.6 },
  a3: { short: 297, long: 420 },
  a4: { short: 210, long: 297 },
  a5: { short: 148, long: 210 },
  a6: { short: 105, long: 148 },
};

const RATIO_ASPECT: Record<`ratio${string}` & MasterPresetId, number> = {
  ratio16x9: 16 / 9,
  ratio4x3: 4 / 3,
  ratio1x1: 1,
  ratio3x2: 3 / 2,
};

export function isFixedMasterPreset(id: MasterPresetId): id is FixedMasterPresetId {
  return id in FIXED_OUTLINE_MM;
}

/** Footprint in mm from a fixed preset and orientation. */
export function fixedOutlineMm(id: FixedMasterPresetId, orientation: MasterOrientation): { baseLength: number; baseWidth: number } {
  const { short, long } = FIXED_OUTLINE_MM[id];
  if (orientation === 'portrait') return { baseWidth: short, baseLength: long };
  return { baseWidth: long, baseLength: short };
}

/**
 * Ratio presets keep the current long edge (mm) and set width:height to the named ratio.
 * Landscape: horizontal is the long edge; portrait: vertical is the long edge.
 */
export function ratioOutlineMm(
  id: keyof typeof RATIO_ASPECT,
  orientation: MasterOrientation,
  longEdgeMm: number,
): { baseLength: number; baseWidth: number } {
  const aspect = RATIO_ASPECT[id];
  if (orientation === 'landscape') {
    return { baseWidth: longEdgeMm, baseLength: longEdgeMm / aspect };
  }
  return { baseLength: longEdgeMm, baseWidth: longEdgeMm / aspect };
}

export function outlineForMasterPreset(
  id: MasterPresetId,
  orientation: MasterOrientation,
  current: { baseLength: number; baseWidth: number },
): { baseLength: number; baseWidth: number } {
  if (isFixedMasterPreset(id)) return fixedOutlineMm(id, orientation);
  const longEdge = Math.max(current.baseLength, current.baseWidth);
  return ratioOutlineMm(id as keyof typeof RATIO_ASPECT, orientation, longEdge);
}

/**
 * Parameter patch for a master size preset: real outline in mm at master scale 1.
 * Does not change plate thickness, plate count, or other master-scale toggles.
 */
export function masterSizePresetPatch(
  raw: Record<string, RawValue>,
  id: MasterPresetId,
  orientation: MasterOrientation,
): Record<string, RawValue> {
  const { values: v } = evaluateParams(raw);
  const { baseLength, baseWidth } = outlineForMasterPreset(id, orientation, {
    baseLength: Number(v.baseLength),
    baseWidth: Number(v.baseWidth),
  });
  return {
    baseLength: String(+baseLength.toFixed(4)),
    baseWidth: String(+baseWidth.toFixed(4)),
    masterScale: '1',
  };
}

/** CLI / scripting alias: preset id strings like `a4`, `iphone17`. */
export const MASTER_PRESET_CLI_IDS: Record<string, MasterPresetId> = {
  iphone17: 'iphone17',
  iphone: 'iphone17',
  a3: 'a3',
  a4: 'a4',
  a5: 'a5',
  a6: 'a6',
  '16:9': 'ratio16x9',
  '16x9': 'ratio16x9',
  '4:3': 'ratio4x3',
  '4x3': 'ratio4x3',
  '1:1': 'ratio1x1',
  '1x1': 'ratio1x1',
  square: 'ratio1x1',
  '3:2': 'ratio3x2',
  '3x2': 'ratio3x2',
};
