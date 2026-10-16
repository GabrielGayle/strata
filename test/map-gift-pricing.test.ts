import { describe, expect, it } from 'vitest';
import { mapGiftPriceFactor, mapPlateAreaMm2 } from '../src/core/mapGiftSizing';
import { estimateMix } from '../src/core/price';
import type { Bom } from '../src/core/bom';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

function row(area: number) {
  const side = Math.sqrt(area);
  return { id: 'P1', w: side, h: side, area, cut: 400, etch: 0, pierces: 4, mass: 0.1, material: 'steel' };
}

function tinyBom(area: number): Bom {
  const r = row(area);
  return {
    rows: [r],
    byMaterial: [{ material: 'steel', partCount: 1, plateMass: r.mass, cutLength: 1, pierces: 1, rows: [r] }],
    plateCount: 1,
    partCount: 1,
    plateArea: area / 1e6,
    plateMass: r.mass,
    cutLength: 1,
    pierces: 1,
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

describe('map gift sizing / pricing (T27)', () => {
  it('lowers price factor for smaller plate areas', () => {
    const big = mapGiftPriceFactor(tinyBom(2_500_000), { bbox: NEASDEN_FAST_BBOX });
    const small = mapGiftPriceFactor(tinyBom(40_000), { bbox: NEASDEN_FAST_BBOX });
    expect(small).toBeLessThan(big);
  });

  it('estimateMix applies map gift factor', () => {
    const bom = tinyBom(50_000);
    const base = estimateMix(bom, 3);
    const discounted = estimateMix(bom, 3, undefined, { mapGiftPriceFactor: 0.5 });
    expect(discounted.subtotal).toBeLessThan(base.subtotal);
    expect(mapPlateAreaMm2(bom)).toBe(50_000);
  });
});
