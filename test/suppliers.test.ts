import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { DEFAULT_RATES, estimateMix, fullEstimate, priceText } from '../src/core/price';
import { supplierCutWarnings, SUPPLIERS } from '../src/core/suppliers';
import { readRates } from '../src/packNode';
import type { Bom } from '../src/core/bom';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

function tinyBom(m: { bom: Bom }, material = 'steel', thickness?: number): Bom {
  const row = { ...m.bom.rows[0], id: 'tiny', w: 10, h: 10, area: 100, cut: 40, etch: 0, pierces: 1, material };
  const g = { material, thickness, rows: [row], partCount: 1, plateMass: 0, cutLength: 0.04, pierces: 1 };
  return { ...m.bom, rows: [row], partCount: 1, cutLength: 0.04, pierces: 1, hardware: [], byMaterial: [g] };
}

describe('supplier profiles', () => {
  const m = createPipeline()(newProject(), assets);

  it('warns when Unicorn cannot cut the thickness', () => {
    expect(supplierCutWarnings(SUPPLIERS.unicorn, 'steel', 0.5).join(' ')).toMatch(/1\.5, 2, 3 mm only\. 0\.5 mm can’t be cut there/);
    expect(supplierCutWarnings(SUPPLIERS.unicorn, 'steel', 1.5)).toEqual([]);
    expect(supplierCutWarnings(SUPPLIERS.chopchop, 'steel', 0.5)).toEqual([]);
    const e = estimateMix(m.bom, 0.5, { ...DEFAULT_RATES, supplier: 'unicorn' });
    expect(e.warnings.some((w) => /can’t be cut there/.test(w))).toBe(true);
  });

  it('applies each supplier’s own minimum and VAT', () => {
    const tiny = tinyBom(m);
    const chop = estimateMix(tiny, 3, DEFAULT_RATES);
    expect(chop.net).toBe(55);
    expect(chop.total).toBeCloseTo(66, 6);
    const unicorn = estimateMix(tiny, 3, { ...DEFAULT_RATES, supplier: 'unicorn' });
    expect(unicorn.net).toBe(50);
    expect(unicorn.total).toBeCloseTo(60, 6); // £60 inc VAT on the quote tool
    const cut = estimateMix(tiny, 3, { ...DEFAULT_RATES, supplier: 'cutitout' });
    expect(cut.net).toBe(20);
    expect(cut.vat).toBe(0);
    expect(cut.total).toBe(20);
    expect(priceText(cut, { ...DEFAULT_RATES, supplier: 'cutitout' })).toMatch(/unconfirmed/);
  });

  it('charges Unicorn’s minimum per material and thickness', () => {
    const a = tinyBom(m, 'steel', 1.5);
    const b = tinyBom(m, 'aluminium', 3);
    const bom: Bom = { ...a, rows: [...a.rows, { ...b.rows[0], id: 'tiny-al' }], partCount: 2, byMaterial: [a.byMaterial[0], { ...b.byMaterial[0], rows: [{ ...b.rows[0], id: 'tiny-al' }] }] };
    const unicorn = estimateMix(bom, 1.5, { ...DEFAULT_RATES, supplier: 'unicorn' });
    expect(unicorn.net).toBeCloseTo(100, 6);
    expect(unicorn.lines.filter((l) => l.label.startsWith('Minimum charge')).length).toBe(2);
    const chop = estimateMix(bom, 1.5, DEFAULT_RATES);
    expect(chop.net).toBeCloseTo(55, 6);
  });

  it('adds labour outside VAT and leaves etch out when asked', () => {
    const base = fullEstimate(m.bom, m.v.thickness, DEFAULT_RATES);
    expect(base.labour).toBeUndefined();
    expect(base.allIn).toBeCloseTo(base.total, 6);
    const lab = fullEstimate(m.bom, m.v.thickness, { ...DEFAULT_RATES, labour: { days: 2.5, dayRate: 300 } });
    expect(lab.labour?.cost).toBe(750);
    expect(lab.total).toBeCloseTo(base.total, 6);
    expect(lab.allIn).toBeCloseTo(base.total + 750, 6);
    expect(priceText(lab, DEFAULT_RATES)).toMatch(/Labour \(est\.\)/);
    expect(m.bom.rows.some((r) => r.etch > 0)).toBe(true);
    const noEtch = fullEstimate(m.bom, m.v.thickness, { ...DEFAULT_RATES, includeEtch: false });
    expect(noEtch.etchM).toBe(0);
    expect(noEtch.total).toBeLessThan(base.total);
  });

  it('reads supplier, etch and labour from a rates file', () => {
    const r = readRates(JSON.stringify({ supplier: 'unicorn', includeEtch: false, labour: { days: 2.5 } }));
    expect(r.supplier).toBe('unicorn');
    expect(r.includeEtch).toBe(false);
    expect(r.labour).toEqual({ days: 2.5, dayRate: 300 });
    expect(() => readRates(JSON.stringify({ supplier: 'acme' }))).toThrow(/supplier/);
    expect(() => readRates(JSON.stringify({ labour: { hours: 3 } }))).toThrow(/labour\.hours/);
  });
});
