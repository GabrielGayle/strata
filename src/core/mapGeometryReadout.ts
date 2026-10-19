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
  /** Height-field max (mm above the concrete). Flat stacks clip to n × thickness. */
  terrainTopMm?: number;
}

/** Laminated block height: every layer is one sheet thick, including empty tops. */
export function flatStackHeightMm(plateCount: number, thicknessMm: number): number {
  return Math.max(0, plateCount) * Math.max(0, thicknessMm);
}

/**
 * Same test as the slicer warning: n layers × thickness do not reach the
 * stamped block’s top. Plate count is left alone (user override).
 */
export function flatStackIsCapped(terrainTopMm: number | undefined, plateCount: number, thicknessMm: number): boolean {
  if (terrainTopMm == null || !Number.isFinite(terrainTopMm) || !(plateCount > 0) || !(thicknessMm > 0)) return false;
  return plateCount * thicknessMm < terrainTopMm - thicknessMm;
}

export interface MapHeightCaptionInput {
  sliceMode: string;
  plates: PlateInfo[];
  thicknessMm: number;
  mapFace: boolean;
  bboxMin: number;
  bboxMax: number;
  terrainTopMm?: number;
}

/** 3D overlay bl.info height line — shared with the Map-tab readout suffix. */
export function formatMapHeightCaption(input: MapHeightCaptionInput): string {
  if (input.sliceMode === 'flat') {
    const n = input.plates.length;
    const stackMm = flatStackHeightMm(n, input.thicknessMm);
    if (flatStackIsCapped(input.terrainTopMm, n, input.thicknessMm)) {
      return `stack height ${mm0(stackMm)} mm · capped at ${n} layers`;
    }
    return `stack height ${mm0(stackMm)} mm`;
  }
  if (input.mapFace) {
    const outline = plateOutlineYRangeMm(input.plates);
    if (outline) return `terrain ${mm0(outline.lo)}–${mm0(outline.hi)} mm`;
  }
  return `plate height ${mm0(input.bboxMin)}–${mm0(input.bboxMax)} mm`;
}

/**
 * Map tab exaggeration line. Suffix is the same string as the 3D caption so
 * ×21 on Stamped is n×thickness (and “capped at N layers” when the terrain
 * wants more), and on Vermilion it is the cut-outline range.
 */
export function formatLiveMapReadout(input: LiveMapGeometryInput): string {
  const caption = formatMapHeightCaption({
    sliceMode: input.sliceMode,
    plates: input.plates,
    thicknessMm: input.thicknessMm,
    mapFace: input.mapFace ?? true,
    bboxMin: input.bboxMin ?? 0,
    bboxMax: input.bboxMax ?? 0,
    terrainTopMm: input.terrainTopMm,
  });
  return `${exaggerationReadout(input.factor)} · ${Math.round(Math.max(0, input.reliefM))} m relief → ${caption}`;
}

/** Size of the terrain grid behind a map face, e.g. "grid 1024 × 1024 px, 8.0 m cells". */
export function formatMapGridReadout(depth: { w: number; h: number; mapOrtho?: { widthM: number; heightM: number } }): string {
  const o = depth.mapOrtho;
  if (!o || !(depth.w > 0) || !(depth.h > 0)) return '';
  const cellM = Math.max(o.widthM / depth.w, o.heightM / depth.h);
  return `grid ${depth.w} × ${depth.h} px, ${cellM < 10 ? cellM.toFixed(1) : Math.round(cellM)} m cells`;
}
