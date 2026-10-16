import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { cutSpeed, DEFAULT_RATES, estimatePrice } from '../src/core/price';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

describe('price estimate', () => {
  const m = createPipeline()(newProject(), assets);

  it('prices the default piece from the Chop Chop fit', () => {
    const e = estimatePrice(m.bom, 'corten', m.v.thickness);
    console.log('estimate', e.net.toFixed(2), 'ex VAT', e.lines.length, 'lines');
    const parts = e.lines.filter((l) => l.label !== 'Minimum order charge');
    expect(parts.map((l) => l.label)).toEqual(m.bom.rows.map((r) => r.id));
    expect(e.fitted).toBe(true);
    expect(e.net).toBeGreaterThanOrEqual(DEFAULT_RATES.minimum);
    expect(e.total).toBeCloseTo(e.net * 1.2, 6);
    expect(e.sheetKg).toBeGreaterThan(m.bom.plateMass);
    expect(m.bom.rows.some((r) => r.etch > 0)).toBe(true);
    expect(e.etchM).toBeGreaterThan(0);
    expect(e.warnings.some((w) => w.includes('Corten') && w.includes('floor'))).toBe(true);
  });

  it('gets slower and dearer with thicker plate', () => {
    expect(cutSpeed('steel', 6)).toBeLessThan(cutSpeed('steel', 3));
    const thin = estimatePrice(m.bom, 'steel', 3);
    const thick = estimatePrice(m.bom, 'steel', 6);
    expect(thick.minutes).toBeGreaterThan(thin.minutes);
    expect(thick.net).toBeGreaterThan(thin.net);
    expect(thin.warnings.filter((w) => !/etch/i.test(w))).toEqual([]);
    expect(thick.warnings.some((w) => /estimate/i.test(w))).toBe(true);
  });

  it('applies the minimum order and flags thicknesses Chop Chop does not list', () => {
    const row = { ...m.bom.rows[0], id: 'tiny', w: 10, h: 10, area: 100, cut: 40, etch: 0, pierces: 1 };
    const tiny = { ...m.bom, rows: [row], partCount: 1, cutLength: 0.04, pierces: 1 };
    const e = estimatePrice(tiny, 'aluminium', 8);
    expect(e.net).toBe(DEFAULT_RATES.minimum);
    expect(e.lines.some((l) => l.label === 'Minimum order charge')).toBe(true);
    expect(e.warnings.some((w) => w.includes('outside'))).toBe(true);
    expect(e.warnings.some((w) => /estimate/i.test(w))).toBe(true);
  });
});

describe('bracing hardware in the price', () => {
  it('adds rod, nuts and washers outside the laser minimum', async () => {
    const { withHardware } = await import('../src/core/price');
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', anchorHoles: '0', rodsOn: true, rodCount: '2', rodSize: 'M6' };
    const m = createPipeline()(p, assets);
    expect(m.bom.hardware.some((r) => r.kind === 'rod' && (r.metres ?? 0) > 0)).toBe(true);
    const base = estimatePrice(m.bom, 'corten', m.v.thickness);
    const rates = { ...DEFAULT_RATES, hardware: { rodPerM: 4, nut: 0.5, washer: 0.25 } };
    const e = withHardware(base, m.bom.hardware, rates);
    const metres = m.bom.hardware.reduce((a, r) => a + (r.metres ?? 0), 0);
    const nuts = m.bom.hardware.filter((r) => r.kind === 'nut').reduce((a, r) => a + r.qty, 0);
    const washers = m.bom.hardware.filter((r) => r.kind === 'washer').reduce((a, r) => a + r.qty, 0);
    const hw = metres * 4 + nuts * 0.5 + washers * 0.25;
    expect(e.hardware).toBeCloseTo(hw, 6);
    expect(e.net).toBeCloseTo(base.net + hw, 6);
    expect(e.total).toBeCloseTo(e.net * 1.2, 6);
    expect(e.lines.map((l) => l.label)).toContain('Threaded rod');
    expect(withHardware(base, [], rates)).toBe(base);
  });
});
