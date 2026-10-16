import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Bom, CutRow } from '../src/core/bom';
import { CHOPCHOP_CALIBRATED, CHOPCHOP_MINIMUM, chopRates, chopUnit } from '../src/core/chopchopRates';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { DEFAULT_RATES, estimateMix, estimatePrice, priceText, usesShopRates } from '../src/core/price';
import { applyPreset, newProject, PRESETS } from '../src/core/project';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'chopchop');

function parseCsv(name: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(join(dir, name), 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.filter(Boolean).map((line) => Object.fromEntries(cols.map((c, i) => [c, line.split(',')[i]])));
}

const geometry = new Map(parseCsv('probe-geometry.csv').map((r) => [r.file, r]));
const quotes = parseCsv('probe-prices.csv');

function rowFrom(file: string, material: string): CutRow {
  const g = geometry.get(file)!;
  return {
    id: file.replace(/\.dxf$/, ''),
    w: Number(g.bbox_w),
    h: Number(g.bbox_h),
    area: Number(g.area_mm2),
    cut: Number(g.cut_length_mm),
    etch: 0,
    pierces: Number(g.pierces),
    mass: 0,
    material,
  };
}

function bomOf(rows: CutRow[]): Bom {
  return {
    rows,
    byMaterial: [],
    plateCount: rows.length,
    partCount: rows.length,
    plateArea: 0,
    plateMass: 0,
    cutLength: rows.reduce((a, r) => a + r.cut, 0) / 1000,
    pierces: rows.reduce((a, r) => a + r.pierces, 0),
    sheets: 1,
    utilisation: 1,
    concreteBase: 0,
    concreteInsert: 0,
    concreteMass: 0,
    plyParts: 0,
    plySheets: 0,
    plyArea: 0,
    dowels: 0,
    bolts: 0,
    pour: [],
    hardware: [],
  };
}

const appMaterial = (name: string) => (name === 'aluminium' ? 'aluminium' : 'steel');

describe('Chop Chop fit, 16 Oct 2026', () => {
  it('names the calibration date', () => {
    expect(CHOPCHOP_CALIBRATED).toBe('16 Oct 2026');
    expect(CHOPCHOP_MINIMUM).toBe(55);
  });

  it('reproduces every probe quote within £0.70', () => {
    expect(quotes.length).toBe(36);
    for (const q of quotes) {
      const material = appMaterial(q.material);
      const thickness = Number(q.thickness);
      const e = estimatePrice(bomOf([rowFrom(q.file, material)]), material, thickness);
      const cost = e.lines.find((l) => l.label !== 'Minimum order charge')!.cost;
      const err = Math.abs(cost - Number(q.unit_price));
      expect(err, `${q.file} ${q.material} ${q.thickness} mm: £${cost.toFixed(2)} vs £${q.unit_price}`).toBeLessThanOrEqual(0.7);
    }
  });

  it('charges true area, so a 100×400 and a 200×200 share the area term', () => {
    const coeff = chopRates('steel', 2).coeff;
    const square = chopUnit(40000, 800, 1, coeff);
    const rectSameCut = chopUnit(40000, 800, 1, coeff);
    expect(rectSameCut).toBeCloseTo(square, 9);
    // the quoted rectangle is longer in the cut, and only in the cut
    expect(chopUnit(40000, 1000, 1, coeff) - square).toBeCloseTo(0.2 * coeff.cut, 6);
    // the zigzag's true area is 75 cm²; its bounding box is 100 cm²
    const g = geometry.get('P08-sq100-zigzag.dxf')!;
    expect(Number(g.area_mm2)).toBe(7500);
    expect(Number(g.bbox_w) * Number(g.bbox_h)).toBe(10000);
    const priced = estimatePrice(bomOf([rowFrom('P08-sq100-zigzag.dxf', 'steel')]), 'steel', 2);
    expect(priced.lines[0].cost).toBeCloseTo(chopUnit(7500, Number(g.cut_length_mm), 1, coeff), 6);
    expect(Math.abs(priced.lines[0].cost - chopUnit(10000, Number(g.cut_length_mm), 1, coeff))).toBeGreaterThan(0.2);
  });

  it('adds a minimum order charge under £55 and skips it once the parts clear it', () => {
    const one = estimatePrice(bomOf([rowFrom('P01-sq50.dxf', 'steel')]), 'steel', 2);
    expect(one.subtotal).toBeLessThan(CHOPCHOP_MINIMUM);
    expect(one.net).toBe(CHOPCHOP_MINIMUM);
    const charge = one.lines.find((l) => l.label === 'Minimum order charge')!;
    expect(charge.cost).toBeCloseTo(CHOPCHOP_MINIMUM - one.subtotal, 6);
    expect(one.total).toBeCloseTo(CHOPCHOP_MINIMUM * 1.2, 6);

    const nine = quotes.filter((q) => q.material === 'mild steel' && q.thickness === '2');
    const pack = estimatePrice(bomOf(nine.map((q) => rowFrom(q.file, 'steel'))), 'steel', 2);
    expect(pack.subtotal).toBeLessThan(CHOPCHOP_MINIMUM);
    expect(pack.net).toBe(CHOPCHOP_MINIMUM);
    expect(pack.lines.filter((l) => l.label === 'Minimum order charge')).toHaveLength(1);

    const big = Array.from({ length: 5 }, (_, i) => ({ ...rowFrom('P04-sq300.dxf', 'steel'), id: `P${i}` }));
    const over = estimatePrice(bomOf(big), 'steel', 3);
    expect(over.subtotal).toBeGreaterThan(CHOPCHOP_MINIMUM);
    expect(over.lines.some((l) => l.label === 'Minimum order charge')).toBe(false);
    expect(over.net).toBeCloseTo(over.subtotal, 6);
  });

  it('prices etch at the cut rate and can leave it out', () => {
    const base = rowFrom('P02-sq100.dxf', 'steel');
    const etched = { ...base, etch: 1000 };
    const on = estimatePrice(bomOf([etched]), 'steel', 3);
    const off = estimatePrice(bomOf([etched]), 'steel', 3, DEFAULT_RATES, { includeEtch: false });
    expect(on.lines[0].cost - off.lines[0].cost).toBeCloseTo(chopRates('steel', 3).coeff.cut, 6);
    expect(on.etchM).toBeCloseTo(1, 6);
    expect(off.etchM).toBe(0);
    expect(on.warnings.some((w) => /etch/i.test(w) && /cut rate/i.test(w))).toBe(true);
    expect(off.warnings.some((w) => /left out/i.test(w) && /cut rate/i.test(w))).toBe(true);
  });

  it('interpolates thickness and treats corten as a mild-steel floor', () => {
    const mid = chopRates('steel', 2.5);
    expect(mid.estimated).toBe(true);
    expect(mid.how).toBe('interpolated');
    expect(mid.coeff.area).toBeCloseTo((0.013 + 0.0137) / 2, 8);
    expect(mid.coeff.cut).toBeCloseTo((2.57 + 4.35) / 2, 8);
    expect(mid.coeff.pierce).toBeCloseTo((0.037 + 0.059) / 2, 8);
    expect(mid.coeff.fixed).toBe(0);
    const below = chopRates('steel', 1);
    expect(below.how).toBe('extrapolated');
    expect(below.coeff.fixed).toBeCloseTo(-0.3 + (0 - -0.3) * ((1 - 1.5) / (2 - 1.5)), 8);
    const alu = chopRates('aluminium', 1.5);
    expect(alu.how).toBe('extrapolated');
    expect(alu.coeff).toEqual(chopRates('aluminium', 3).coeff);
    const row = rowFrom('P02-sq100.dxf', 'steel');
    const steel = estimatePrice(bomOf([row]), 'steel', 3);
    const corten = estimatePrice(bomOf([{ ...row, material: 'corten' }]), 'corten', 3);
    expect(corten.lines[0].cost).toBeCloseTo(steel.lines[0].cost, 6);
    expect(corten.warnings.some((w) => /Corten/.test(w) && /floor/.test(w))).toBe(true);
    expect(steel.warnings.some((w) => /estimate/i.test(w))).toBe(false);
    expect(estimatePrice(bomOf([row]), 'steel', 6).warnings.some((w) => /estimate/i.test(w))).toBe(true);
  });

  it('lets a rates file replace the fit with the shop model', () => {
    const row = rowFrom('P03-sq200.dxf', 'steel');
    expect(usesShopRates(DEFAULT_RATES)).toBe(false);
    expect(usesShopRates({ ...DEFAULT_RATES, minimum: 0 })).toBe(false);
    const rates = { ...DEFAULT_RATES, machinePerHour: 0, setup: 0, perPart: 0, waste: 0, minimum: 0, vat: 0, perKg: { steel: 0, corten: 0, aluminium: 0 } };
    expect(usesShopRates(rates)).toBe(true);
    const e = estimatePrice(bomOf([row]), 'steel', 3, rates);
    expect(e.fitted).toBe(false);
    expect(e.total).toBe(0);
    expect(e.lines.map((l) => l.label)).toEqual(['Material', 'Laser time', 'Setup', 'Handling']);
  });

  it('says delivery is excluded and that the qty discount is left off', () => {
    const text = priceText(estimatePrice(bomOf([rowFrom('P02-sq100.dxf', 'steel')]), 'steel', 3));
    expect(text).toMatch(/Delivery is not included/);
    expect(text).toMatch(/No quantity discount is applied/);
    expect(text).toMatch(/8%/);
    expect(text).toMatch(/16 Oct 2026/);
    expect(text).toMatch(/Minimum order charge/);
  });
});

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('preset estimates against the Chop Chop quotes', () => {
  const cases = [
    { name: 'Vermilion 40', params: { plateMaterial: 'steel', thickness: '3' }, quote: 475.31 },
    { name: 'Mini radial', params: { plateMaterial: 'steel', thickness: '2' }, quote: 55 },
    { name: 'Waffle field', params: { plateMaterial: 'aluminium', thickness: '3' }, quote: 378.15 },
    { name: 'Image cliff', params: { plateMaterial: 'steel', thickness: '1.5' }, quote: 357.4 },
  ];

  it('prices the four quoted presets', { timeout: 60_000 }, () => {
    for (const c of cases) {
      const preset = PRESETS.find((p) => p.name === c.name)!;
      const project = applyPreset(newProject(), preset);
      project.params = { ...project.params, ...c.params };
      const model = createPipeline()(project, assets);
      const est = estimateMix(model.bom, model.v.thickness);
      console.log(`${c.name}: £${est.net.toFixed(2)} ex VAT (quote £${c.quote.toFixed(2)}), etch ${est.etchM.toFixed(2)} m, ${model.bom.partCount} parts, subtotal £${est.subtotal.toFixed(2)}`);
      expect(est.fitted).toBe(true);
      expect(est.total).toBeCloseTo(est.net * 1.2, 6);
      expect(est.net).toBeGreaterThanOrEqual(CHOPCHOP_MINIMUM);
    }
  });
});
