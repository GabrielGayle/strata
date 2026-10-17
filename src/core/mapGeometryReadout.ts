// Live Map-tab / 3D caption millimetres from the sliced model — not the
// plan-scale estimate baked at fetch time (that line used masterWidth at
// kickoff, so Stamped’s 520 mm could linger on a Vermilion 800 mm build).
import { exaggerationReadout } from './mapExaggeration';
import { plateOutlineYRangeMm, type PlateInfo } from './slicer';

export function mm0(n: number): string {
  return Number.isFinite(n) ? n.toFixed(0) : '–';
}

export interface LiveMapGeometryInput {
  factor: number;
  reliefM: number;
  sliceMode: string;
  plates: PlateInfo[];
  thicknessMm: number;
  mapFace?: boolean;
  bboxMin?: number;
  bboxMax?: number;
}

/** 3D overlay bl.info height line — shared with the Map-tab readout suffix. */
export function formatMapHeightCaption(input: {
  sliceMode: string;
  plates: PlateInfo[];
  thicknessMm: number;
  mapFace: boolean;
  bboxMin: number;
  bboxMax: number;
}): string {
  if (input.sliceMode === 'flat') {
    return `stack height ${mm0(input.plates.length * input.thicknessMm)} mm`;
  }
  if (input.mapFace) {
    const outline = plateOutlineYRangeMm(input.plates);
    if (outline) return `terrain ${mm0(outline.lo)}–${mm0(outline.hi)} mm`;
  }
  return `plate height ${mm0(input.bboxMin)}–${mm0(input.bboxMax)} mm`;
}

/**
 * Map tab exaggeration line. Suffix is the same string as the 3D caption so
 * ×21 on Stamped is n×thickness, and on Vermilion it is the cut-outline range.
 */
export function formatLiveMapReadout(input: LiveMapGeometryInput): string {
  const caption = formatMapHeightCaption({
    sliceMode: input.sliceMode,
    plates: input.plates,
    thicknessMm: input.thicknessMm,
    mapFace: input.mapFace ?? true,
    bboxMin: input.bboxMin ?? 0,
    bboxMax: input.bboxMax ?? 0,
  });
  return `${exaggerationReadout(input.factor)} · ${Math.round(Math.max(0, input.reliefM))} m relief → ${caption}`;
}
