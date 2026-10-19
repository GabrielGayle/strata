// Auto vertical exaggeration for map reliefs (plan §4.4).
import type { Float32Grid } from './mapGrid';
import { gridMetricWidthHeight } from './mapProject';

export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 50;
/** Slider / number-input step. Integers and existing choices sit on this grid. */
export const EXAGGERATION_STEP = 0.25;

/**
 * Dropdown values: fine steps through ×3 (wall relief / low London hills), then
 * the historical larger choices. Stored numbers that are not in this list still
 * load unchanged — the UI adds the current value as an extra option.
 */
export const EXAGGERATION_CHOICES = [1, 1.25, 1.5, 2, 2.5, 3, 4, 8, 11, 12, 16, 18, 21, 28, 36] as const;

/**
 * Apparent slope we allow auto to paint on a wall sculpture.
 *
 * `trueRelief / mapWidth` is the DEM’s real slope. Auto never pushes that
 * product above 3% on landscapes that are themselves flatter than 3%.
 *
 * Worked examples (see `test/map-exaggeration-auto.test.ts`):
 *
 * - Woolwich (Shooters Hill, 125 m over 10.82 km ≈ 1.16%): cap = 0.03 / 0.0116
 *   ≈ ×2.6. Stack-fill on the project’s 46 × 1.5 mm / 720 mm stack is ≈ ×9.5;
 *   an A3 30 × 3 mm / 400 mm stack is ≈ ×21 — the spike in Woolwich-iso.png.
 * - Neasden city hills (~45 m over 3.25 km ≈ 1.4%): cap ≈ ×2.2 (was stack-fill
 *   ×11 on Vermilion 40). Same rule; the map is still low-relief.
 * - Buttermere / Grasmoor (~750 m over ~8 km ≈ 9%): already steeper than 3%,
 *   so the cap does not apply and stack-fill (~×1.6 on Vermilion 40) is unchanged.
 */
export const AUTO_TARGET_SLOPE = 0.03;

export interface AutoExaggerationInput {
  /** Physical relief in metres (typically p98 − p2) used for stack-fill. */
  reliefM: number;
  /** Target stack height in millimetres (plate count × thickness). */
  stackHeightMm: number;
  /** Ground width of the map bbox in metres. */
  mapWidthM: number;
  /** Master outline width in millimetres (long edge of the base). */
  masterWidthMm: number;
  /**
   * True (max − min) metres for the low-relief cap. Defaults to `reliefM`.
   * Peaks (Shooters Hill) must constrain the factor even when p98−p2 is smaller.
   */
  trueReliefM?: number;
}

function clampExaggeration(n: number): number {
  return Math.min(EXAGGERATION_MAX, Math.max(EXAGGERATION_MIN, n));
}

/** Relief × exaggeration × (masterWidth/mapWidth) maps to stack height in mm. Uncapped. */
export function stackFillExaggeration(input: AutoExaggerationInput): number {
  const { reliefM, stackHeightMm, mapWidthM, masterWidthMm } = input;
  if (!(reliefM > 0) || !(mapWidthM > 0) || !(masterWidthMm > 0) || !(stackHeightMm > 0)) return EXAGGERATION_MIN;
  const scaleMmPerM = masterWidthMm / mapWidthM;
  const raw = stackHeightMm / (reliefM * scaleMmPerM);
  return clampExaggeration(raw);
}

/**
 * Upper bound from DEM slope. Landscapes already steeper than {@link AUTO_TARGET_SLOPE}
 * return {@link EXAGGERATION_MAX} so stack-fill is not reduced (Buttermere).
 */
export function lowReliefExaggerationCap(trueReliefM: number, mapWidthM: number): number {
  if (!(trueReliefM > 0) || !(mapWidthM > 0)) return EXAGGERATION_MAX;
  const aspect = trueReliefM / mapWidthM;
  if (aspect >= AUTO_TARGET_SLOPE) return EXAGGERATION_MAX;
  return AUTO_TARGET_SLOPE / aspect;
}

/**
 * Auto factor: min(stack-fill, low-relief cap), clamped to [1, 50].
 *
 * Stack-fill still uses robust (p98−p2) metres so a few noisy pixels do not
 * collapse the factor. The cap uses true max−min / map width so an isolated
 * peak on a pancake (Woolwich) cannot be stretched to fill the whole stack.
 */
export function computeAutoExaggeration(input: AutoExaggerationInput): number {
  const fill = stackFillExaggeration(input);
  const peakM = input.trueReliefM != null && input.trueReliefM > 0 ? input.trueReliefM : input.reliefM;
  const cap = lowReliefExaggerationCap(peakM, input.mapWidthM);
  return clampExaggeration(Math.min(fill, cap));
}

export function exaggerationReadout(factor: number): string {
  const quarter = Math.round(factor * 4) / 4;
  if (Math.abs(factor - quarter) < 1e-6) return `×${quarter}`;
  const n = Math.round(factor * 10) / 10;
  return `×${n}`;
}

/** Select options: `auto`, the standard ladder, plus a stray stored value. */
export function exaggerationSelectValues(current: number | 'auto'): Array<number | 'auto'> {
  const values: Array<number | 'auto'> = ['auto', ...EXAGGERATION_CHOICES];
  if (typeof current === 'number' && current > 0 && !EXAGGERATION_CHOICES.some((n) => n === current)) {
    values.push(current);
    const nums = values.filter((v): v is number => v !== 'auto').sort((a, b) => a - b);
    return ['auto', ...nums];
  }
  return values;
}

/**
 * Plan-scale estimate at map-build time (relief × factor × master/mapWidth).
 * The Map tab live line is `formatLiveMapReadout` so it matches the 3D model
 * (flat: n×thickness, plus “capped at N layers” when the height field is
 * taller; upright: cut-outline lo–hi), not a stale master width.
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

function percentile(sorted: ArrayLike<number>, p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/** Robust relief (p98 − p2). Used only to pick the auto exaggeration *factor*. One typed sort, both percentiles. */
export function reliefMetres(grid: Float32Grid): number {
  const finite = new Float32Array(grid.data.length);
  let n = 0;
  for (const v of grid.data) if (Number.isFinite(v)) finite[n++] = v;
  if (n < 2) return 0;
  const sorted = finite.subarray(0, n).sort();
  return Math.max(0, percentile(sorted, 98) - percentile(sorted, 2));
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
    const factor = clampExaggeration(spec.exaggeration);
    return {
      factor,
      readout: formatExaggerationStackReadout(factor, trueReliefMetres(grid), mapWidthM, stack.masterWidthMm),
      auto: false,
    };
  }
  const robustRelief = Math.max(1, reliefMetres(grid));
  const trueRelief = trueReliefMetres(grid);
  const stackHeightMm = stack.plateCount * stack.thicknessMm;
  const factor = computeAutoExaggeration({
    reliefM: robustRelief,
    trueReliefM: trueRelief,
    stackHeightMm,
    mapWidthM,
    masterWidthMm: stack.masterWidthMm,
  });
  // Stack-fill (p98−p2) is still the first term. On low-relief maps the 3%
  // slope cap wins — Woolwich lands near ×2.6, not the A3 ×18–21 / Vermilion
  // ×11 stack-fill numbers. Mountains (Buttermere) keep stack-fill. Readout
  // and plates use true max − min.
  const readout = formatExaggerationStackReadout(factor, trueRelief, mapWidthM, stack.masterWidthMm);
  return { factor, readout, auto: true };
}
