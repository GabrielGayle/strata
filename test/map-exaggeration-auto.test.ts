import { describe, expect, it } from 'vitest';
import {
  AUTO_TARGET_SLOPE,
  EXAGGERATION_CHOICES,
  EXAGGERATION_MIN,
  EXAGGERATION_STEP,
  computeAutoExaggeration,
  exaggerationReadout,
  exaggerationSelectValues,
  lowReliefExaggerationCap,
  stackFillExaggeration,
} from '../src/core/mapExaggeration';
import { BUTTERMERE_DEM_STATS, WOOLWICH_DEM_STATS } from './map-fixtures';

const woolwichStack = {
  reliefM: WOOLWICH_DEM_STATS.robustReliefM,
  trueReliefM: WOOLWICH_DEM_STATS.trueReliefM,
  stackHeightMm: WOOLWICH_DEM_STATS.plateCount * WOOLWICH_DEM_STATS.thicknessMm,
  mapWidthM: WOOLWICH_DEM_STATS.mapWidthM,
  masterWidthMm: WOOLWICH_DEM_STATS.masterWidthMm,
};

const buttermereStack = {
  reliefM: BUTTERMERE_DEM_STATS.robustReliefM,
  trueReliefM: BUTTERMERE_DEM_STATS.trueReliefM,
  stackHeightMm: BUTTERMERE_DEM_STATS.plateCount * BUTTERMERE_DEM_STATS.thicknessMm,
  mapWidthM: BUTTERMERE_DEM_STATS.mapWidthM,
  masterWidthMm: BUTTERMERE_DEM_STATS.masterWidthMm,
};

describe('auto exaggeration slope cap', () => {
  it('flat: Woolwich DEM stats land in ×1.5–×3, not the stack-fill spike', () => {
    const fill = stackFillExaggeration(woolwichStack);
    const auto = computeAutoExaggeration(woolwichStack);
    const aspect = WOOLWICH_DEM_STATS.trueReliefM / WOOLWICH_DEM_STATS.mapWidthM;
    expect(aspect).toBeLessThan(AUTO_TARGET_SLOPE);
    expect(fill).toBeGreaterThan(8);
    expect(fill).toBeLessThan(11);
    expect(auto).toBeGreaterThanOrEqual(1.5);
    expect(auto).toBeLessThanOrEqual(3);
    expect(auto).toBeCloseTo(AUTO_TARGET_SLOPE / aspect, 5);
    // A3 30×3 mm / 400 mm on the same DEM is the ×21 the UI used to jump to.
    const a3Fill = stackFillExaggeration({
      ...woolwichStack,
      stackHeightMm: 90,
      masterWidthMm: 400,
    });
    expect(a3Fill).toBeGreaterThan(20);
    expect(a3Fill).toBeLessThan(23);
    expect(computeAutoExaggeration({ ...woolwichStack, stackHeightMm: 90, masterWidthMm: 400 })).toBeCloseTo(auto, 5);
  });

  it('hilly: 80 m over 4 km is still under 3%, so auto follows the slope cap', () => {
    const input = {
      reliefM: 70,
      trueReliefM: 80,
      stackHeightMm: 120,
      mapWidthM: 4000,
      masterWidthMm: 800,
    };
    const fill = stackFillExaggeration(input);
    const auto = computeAutoExaggeration(input);
    expect(fill).toBeGreaterThan(5);
    expect(auto).toBeGreaterThanOrEqual(1.5);
    expect(auto).toBeLessThanOrEqual(2);
    expect(auto).toBeCloseTo(AUTO_TARGET_SLOPE / (80 / 4000), 5);
    expect(auto).toBeLessThan(fill);
  });

  it('mountain: Buttermere stack-fill is unchanged', () => {
    const fill = stackFillExaggeration(buttermereStack);
    const auto = computeAutoExaggeration(buttermereStack);
    const aspect = BUTTERMERE_DEM_STATS.trueReliefM / BUTTERMERE_DEM_STATS.mapWidthM;
    expect(aspect).toBeGreaterThan(AUTO_TARGET_SLOPE);
    expect(lowReliefExaggerationCap(BUTTERMERE_DEM_STATS.trueReliefM, BUTTERMERE_DEM_STATS.mapWidthM)).toBe(50);
    expect(auto).toBeCloseTo(fill, 8);
    expect(auto).toBeGreaterThanOrEqual(1);
    expect(auto).toBeLessThan(2.2);
  });

  it('exposes the fine ladder and keeps a stray stored value in the select', () => {
    expect(EXAGGERATION_MIN).toBe(1);
    expect(EXAGGERATION_STEP).toBe(0.25);
    for (const n of [1, 1.25, 1.5, 2, 2.5, 3, 4, 21]) {
      expect(EXAGGERATION_CHOICES).toContain(n);
    }
    expect(exaggerationSelectValues('auto')[0]).toBe('auto');
    expect(exaggerationSelectValues(1.5)).toContain(1.5);
    expect(exaggerationSelectValues(7)).toEqual(['auto', 1, 1.25, 1.5, 2, 2.5, 3, 4, 7, 8, 11, 12, 16, 18, 21, 28, 36]);
    expect(exaggerationReadout(1.25)).toBe('×1.25');
    expect(exaggerationReadout(1.5)).toBe('×1.5');
    expect(exaggerationReadout(21)).toBe('×21');
  });
});
