// Chop Chop Laser per-part rates, calibrated 16 Oct 2026.
//
// Nine probe shapes (data/chopchop/probe-geometry.csv) were quoted at qty 1,
// ex VAT, on mild steel 1.5 / 2 / 3 mm and aluminium 3 mm
// (data/chopchop/probe-prices.csv). The fit is
//
//   unit = area_cm2 * A + cut_m * C + pierces * P + fixed
//
// Area is the true part area, not the bounding box (a 100×400 rectangle has
// the same area charge as a 200×200 square). Cut length includes ETCH-layer
// lines: Chop Chop prices etch as cut. fixed is ~0, except 1.5 mm mild steel,
// where the regression intercept is −£0.30. Dropping that intercept misses the
// 200 mm square and the 100×400 rectangle by more than £0.70.
//
// Other thicknesses are a straight line through these gauges and are estimates.
// Corten is not offered; mild steel is the floor.

export interface ChopCoeff {
  /** £ per cm² of true part area. */
  area: number;
  /** £ per metre of cut. ETCH-layer lines are cut. */
  cut: number;
  /** £ per pierce. */
  pierce: number;
  /** £ per part. ~0, except the 1.5 mm mild-steel intercept. */
  fixed: number;
}

export interface ChopGauge {
  material: 'steel' | 'aluminium';
  /** mm */
  thickness: number;
  coeff: ChopCoeff;
}

/** Quoted gauges. Order within a material does not matter. */
export const CHOPCHOP_GAUGES: readonly ChopGauge[] = [
  { material: 'steel', thickness: 1.5, coeff: { area: 0.0119, cut: 1.92, pierce: 0.044, fixed: -0.3 } },
  { material: 'steel', thickness: 2, coeff: { area: 0.013, cut: 2.57, pierce: 0.037, fixed: 0 } },
  { material: 'steel', thickness: 3, coeff: { area: 0.0137, cut: 4.35, pierce: 0.059, fixed: 0 } },
  { material: 'aluminium', thickness: 3, coeff: { area: 0.0111, cut: 4.62, pierce: 0.06, fixed: 0 } },
];

/** £ ex VAT. Chop Chop's order minimum on 16 Oct 2026. */
export const CHOPCHOP_MINIMUM = 55;

/** Date of the quotes this file was fitted to. */
export const CHOPCHOP_CALIBRATED = '16 Oct 2026';

export interface ChopRate {
  coeff: ChopCoeff;
  /** False only on a thickness Chop Chop actually quoted for this material. */
  estimated: boolean;
  how: 'fitted' | 'interpolated' | 'extrapolated';
  /** Corten is priced on the mild-steel line. */
  corten: boolean;
  /** Quoted thicknesses for this material, ascending. */
  gauges: number[];
}

const clampRate = (c: ChopCoeff): ChopCoeff => ({
  area: Math.max(0, c.area),
  cut: Math.max(0, c.cut),
  pierce: Math.max(0, c.pierce),
  fixed: c.fixed,
});

function lerp(a: ChopCoeff, b: ChopCoeff, t: number): ChopCoeff {
  const m = (x: number, y: number) => x + (y - x) * t;
  return clampRate({ area: m(a.area, b.area), cut: m(a.cut, b.cut), pierce: m(a.pierce, b.pierce), fixed: m(a.fixed, b.fixed) });
}

function gaugesFor(material: 'steel' | 'aluminium'): ChopGauge[] {
  return CHOPCHOP_GAUGES.filter((g) => g.material === material).sort((a, b) => a.thickness - b.thickness);
}

/** Coefficients for a material and thickness. Corten uses mild steel. */
export function chopRates(material: string, thickness: number): ChopRate {
  const corten = material === 'corten';
  const family = material === 'aluminium' ? 'aluminium' : 'steel';
  const gauges = gaugesFor(family);
  const thicknesses = gauges.map((g) => g.thickness);
  const exact = gauges.find((g) => Math.abs(g.thickness - thickness) < 1e-6);
  if (exact) return { coeff: exact.coeff, estimated: false, how: 'fitted', corten, gauges: thicknesses };
  if (gauges.length === 1) return { coeff: gauges[0].coeff, estimated: true, how: 'extrapolated', corten, gauges: thicknesses };
  const span = (i: number) => {
    const a = gauges[i];
    const b = gauges[i + 1];
    return lerp(a.coeff, b.coeff, (thickness - a.thickness) / (b.thickness - a.thickness));
  };
  if (thickness < gauges[0].thickness) return { coeff: span(0), estimated: true, how: 'extrapolated', corten, gauges: thicknesses };
  for (let i = 0; i < gauges.length - 1; i++) {
    if (thickness <= gauges[i + 1].thickness) return { coeff: span(i), estimated: true, how: 'interpolated', corten, gauges: thicknesses };
  }
  return { coeff: span(gauges.length - 2), estimated: true, how: 'extrapolated', corten, gauges: thicknesses };
}

/** Qty-1 unit price, ex VAT. Area and cut are in mm and mm of path. */
export function chopUnit(areaMm2: number, cutMm: number, pierces: number, coeff: ChopCoeff): number {
  const unit = (areaMm2 / 100) * coeff.area + (cutMm / 1000) * coeff.cut + pierces * coeff.pierce + coeff.fixed;
  return Math.max(0, unit);
}
