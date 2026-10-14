import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { cutSpeed, DEFAULT_RATES, estimatePrice } from '../src/core/price';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

describe('price estimate', () => {
  const m = createPipeline()(newProject(), assets);

  it('prices the default piece from its cut list', () => {
    const e = estimatePrice(m.bom, 'corten', m.v.thickness);
    console.log('estimate', e.lines.map((l) => `${l.label} £${l.cost.toFixed(2)} (${l.detail})`), 'total', e.total.toFixed(2));
    expect(e.lines.map((l) => l.label)).toEqual(['Material', 'Laser time', 'Setup', 'Handling']);
    expect(e.net).toBeGreaterThanOrEqual(DEFAULT_RATES.minimum);
    expect(e.total).toBeCloseTo(e.net * 1.2, 6);
    expect(e.sheetKg).toBeGreaterThan(m.bom.plateMass);
    expect(e.warnings.some((w) => w.includes('Corten'))).toBe(true);
  });

  it('gets slower and dearer with thicker plate', () => {
    expect(cutSpeed('steel', 6)).toBeLessThan(cutSpeed('steel', 3));
    const thin = estimatePrice(m.bom, 'steel', 3);
    const thick = estimatePrice(m.bom, 'steel', 6);
    expect(thick.minutes).toBeGreaterThan(thin.minutes);
    expect(thick.net).toBeGreaterThan(thin.net);
    expect(thin.warnings).toEqual([]);
  });

  it('applies the minimum order and flags thicknesses Chop Chop does not list', () => {
    const tiny = { ...m.bom, rows: m.bom.rows.slice(0, 1), partCount: 1, cutLength: 0.2, pierces: 1 };
    const e = estimatePrice(tiny, 'aluminium', 8);
    expect(e.net).toBe(DEFAULT_RATES.minimum);
    expect(e.warnings.some((w) => w.includes('outside'))).toBe(true);
  });
});
