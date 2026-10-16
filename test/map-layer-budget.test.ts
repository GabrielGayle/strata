import { describe, expect, it } from 'vitest';
import { computeAutoExaggeration, exaggerationReadout, resolveExaggerationFactor } from '../src/core/mapExaggeration';
import { computeLayerBreaks, equalBreaks, jenksBreaks, quantileBreaks, applyLayerBudget } from '../src/core/mapLayerBudget';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { depthToGray } from '../src/core/depth';

describe('map layer budget + exaggeration', () => {
  it('auto exaggeration matches the stack-height formula (Neasden example)', () => {
    const ex = computeAutoExaggeration({
      reliefM: 35,
      stackHeightMm: 90,
      mapWidthM: 3250,
      masterWidthMm: 400,
    });
    expect(ex).toBeGreaterThan(19);
    expect(ex).toBeLessThan(23);
    expect(exaggerationReadout(ex)).toBe('×20.9');
  });

  it('Jenks breaks differ from equal breaks on skewed data', () => {
    const skewed = [0, 0, 0, 0, 0, 1, 2, 3, 4, 50];
    const j = jenksBreaks(skewed, 3);
    const e = equalBreaks(0, 50, 3);
    expect(j.length).toBe(3);
    expect(j).not.toEqual(e);
  });

  it('produces N layer breaks and N flat-stack plates with auto exaggeration readout', () => {
    const grid = syntheticConeGrid(48, 24, 18);
    const budget = computeLayerBreaks(grid, 12, 'jenks');
    expect(budget.breaksM.length).toBe(12);
    const snapped = applyLayerBudget(grid, budget.breaksM);
    const { factor, readout } = resolveExaggerationFactor({ exaggeration: 'auto' }, snapped, {
      plateCount: 12,
      thicknessMm: 3,
      masterWidthMm: 520,
    });
    expect(factor).toBeGreaterThanOrEqual(1);
    expect(readout).toMatch(/^×/);

    const six = computeLayerBreaks(snapped, 6, 'jenks');
    expect(six.breaksM.length).toBe(6);
    const { depth } = mapGridToDepth(applyLayerBudget(snapped, six.breaksM), { exaggeration: factor });
    const p = newProject();
    const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
    p.params = { ...p.params, ...preset.params, plateCount: '6', topDepth: '40' };
    const gray = depthToGray(depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.sliced.plates.length).toBe(6);
  });

  it('quantile and equal modes return the requested break count', () => {
    const vals = Array.from({ length: 100 }, (_, i) => i);
    expect(quantileBreaks(vals, 8).length).toBe(8);
    expect(equalBreaks(0, 99, 8).length).toBe(8);
  });
});
