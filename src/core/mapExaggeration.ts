// Auto vertical exaggeration for map reliefs (plan §4.4).
import type { Float32Grid } from './mapGrid';
import { gridMetricWidthHeight } from './mapProject';

export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 50;

export interface AutoExaggerationInput {
  /** Physical relief in metres (typically p98 − p2). */
  reliefM: number;
  /** Target stack height in millimetres (plate count × thickness). */
  stackHeightMm: number;
  /** Ground width of the map bbox in metres. */
  mapWidthM: number;
  /** Master outline width in millimetres (long edge of the base). */
  masterWidthMm: number;
}

/** Relief × exaggeration × (masterWidth/mapWidth) maps to stack height in mm. */
export function computeAutoExaggeration(input: AutoExaggerationInput): number {
  const { reliefM, stackHeightMm, mapWidthM, masterWidthMm } = input;
  if (!(reliefM > 0) || !(mapWidthM > 0) || !(masterWidthMm > 0) || !(stackHeightMm > 0)) return EXAGGERATION_MIN;
  const scaleMmPerM = masterWidthMm / mapWidthM;
  const raw = stackHeightMm / (reliefM * scaleMmPerM);
  return Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, raw));
}

export function exaggerationReadout(factor: number): string {
  const n = Math.round(factor * 10) / 10;
  return `×${n}`;
}

function percentile(vals: number[], p: number): number {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

export function reliefMetres(grid: Float32Grid): number {
  const finite: number[] = [];
  for (const v of grid.data) if (Number.isFinite(v)) finite.push(v);
  if (finite.length < 2) return 0;
  return Math.max(0, percentile(finite, 98) - percentile(finite, 2));
}

export function resolveExaggerationFactor(
  spec: { exaggeration: number | 'auto' },
  grid: Float32Grid,
  stack: { plateCount: number; thicknessMm: number; masterWidthMm: number },
): { factor: number; readout: string; auto: boolean } {
  if (typeof spec.exaggeration === 'number' && spec.exaggeration > 0) {
    const factor = Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, spec.exaggeration));
    return { factor, readout: exaggerationReadout(factor), auto: false };
  }
  const { widthM } = gridMetricWidthHeight(grid);
  const mapWidthM = Math.max(widthM, 1);
  const factor = computeAutoExaggeration({
    reliefM: Math.max(1, reliefMetres(grid)),
    stackHeightMm: stack.plateCount * stack.thicknessMm,
    mapWidthM,
    masterWidthMm: stack.masterWidthMm,
  });
  return { factor, readout: exaggerationReadout(factor), auto: true };
}
