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

/**
 * Plan-scale estimate at map-build time (relief × factor × master/mapWidth).
 * The Map tab live line is `formatLiveMapReadout` so it matches the 3D model
 * (flat: n×thickness; upright: cut-outline lo–hi), not a stale master width.
 */
export function formatExaggerationStackReadout(
  factor: number,
  reliefM: number,
  mapWidthM: number,
  masterWidthMm: number,
): string {
  const scale = mapWidthM > 0 && masterWidthMm > 0 ? masterWidthMm / mapWidthM : 0;
  const stackMm = Math.max(0, reliefM) * Math.max(0, factor) * scale;
  return `${exaggerationReadout(factor)} · ${Math.round(reliefM)} m relief → ${Math.round(stackMm)} mm stack on ${Math.round(masterWidthMm)} mm`;
}

function percentile(vals: number[], p: number): number {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/** Robust relief (p98 − p2). Used only to pick the auto exaggeration *factor*. */
export function reliefMetres(grid: Float32Grid): number {
  const finite: number[] = [];
  for (const v of grid.data) if (Number.isFinite(v)) finite.push(v);
  if (finite.length < 2) return 0;
  return Math.max(0, percentile(finite, 98) - percentile(finite, 2));
}

/** True (max − min) metres — same measure as `mapOrtho.reliefM` / plate heights. */
export function trueReliefMetres(grid: Float32Grid): number {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const v of grid.data) {
    if (!Number.isFinite(v)) continue;
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  if (!(zMax >= zMin) || !Number.isFinite(zMin)) return 0;
  return zMax - zMin;
}

export function resolveExaggerationFactor(
  spec: { exaggeration: number | 'auto' },
  grid: Float32Grid,
  stack: { plateCount: number; thicknessMm: number; masterWidthMm: number },
): { factor: number; readout: string; auto: boolean } {
  const { widthM } = gridMetricWidthHeight(grid);
  const mapWidthM = Math.max(widthM, 1);
  if (typeof spec.exaggeration === 'number' && spec.exaggeration > 0) {
    const factor = Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, spec.exaggeration));
    return {
      factor,
      readout: formatExaggerationStackReadout(factor, trueReliefMetres(grid), mapWidthM, stack.masterWidthMm),
      auto: false,
    };
  }
  const robustRelief = Math.max(1, reliefMetres(grid));
  const stackHeightMm = stack.plateCount * stack.thicknessMm;
  const factor = computeAutoExaggeration({
    reliefM: robustRelief,
    stackHeightMm,
    mapWidthM,
    masterWidthMm: stack.masterWidthMm,
  });
  // ×18–21 is the A3 / 30×3 mm plan number (420 mm, ~35 m, ~3.25 km). Default
  // Vermilion 40 is 800 mm × 40×3 mm — the same formula lands near ×11 for
  // live EA 1 m relief on the full Neasden bbox. Factor from p98−p2; readout
  // and plates use true max − min.
  const readout = formatExaggerationStackReadout(factor, trueReliefMetres(grid), mapWidthM, stack.masterWidthMm);
  return { factor, readout, auto: true };
}
