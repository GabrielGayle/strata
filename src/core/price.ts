// Laser cutting price estimate for Chop Chop Laser (chopchoplaser.co.uk).
//
// The default is the per-part fit in chopchopRates.ts (calibrated 16 Oct 2026).
// A rates file can still replace that fit with the older shop model: pass a
// PriceRates whose sheet, laser, setup or handling figures differ from
// DEFAULT_RATES. The headless CLI's --rates file (which may land separately)
// builds that object; this module does not depend on the CLI.
import type { Bom, CutRow } from './bom';
import type { HardwareRow } from './brace';
import { CHOPCHOP_CALIBRATED, CHOPCHOP_MINIMUM, chopRates, chopUnit, orderSizeFactor, type ChopRate } from './chopchopRates';

export const CHOPCHOP_URL = 'https://www.chopchoplaser.co.uk/';
export const CHOPCHOP_QUOTE_URL = 'https://qm.tempustools.com/store/3bf51dae-32c7-4592-9ec5-17fea51a6558';

/** What Chop Chop lists on its site: thickness ranges per metal and a 3 m × 1.5 m bed. */
export const CHOPCHOP_RANGE: Record<string, [number, number]> = { steel: [0.5, 10], aluminium: [0.5, 5] };
export const CHOPCHOP_BED = { w: 3000, h: 1500 };

export interface PriceRates {
  /** £ per kg of sheet bought, by plate material. Shop model only. */
  perKg: Record<string, number>;
  /** Extra sheet charged on top of the parts' bounding boxes (offcuts, skeleton). Shop model only. */
  waste: number; // fraction
  machinePerHour: number; // £, shop model only
  setup: number; // £ per job, shop model only
  perPart: number; // £ handling / deburr per part, shop model only
  minimum: number; // £ minimum order, ex VAT
  vat: number; // fraction
  /** Bracing hardware bought in (not from Chop Chop): £ per metre of threaded bar, £ per nut, £ per washer. */
  hardware: { rodPerM: number; nut: number; washer: number };
}

export const DEFAULT_RATES: PriceRates = {
  perKg: { steel: 1.4, corten: 2.6, aluminium: 6.5 },
  waste: 0.25,
  machinePerHour: 90,
  setup: 25,
  perPart: 0.35,
  minimum: CHOPCHOP_MINIMUM,
  vat: 0.2,
  // zinc-plated M6–M8 from a fastener supplier, small-pack prices
  hardware: { rodPerM: 3, nut: 0.08, washer: 0.05 },
};

/** True when `rates` replaces the fitted Chop Chop prices with the shop model. */
export function usesShopRates(rates: PriceRates): boolean {
  if (rates.waste !== DEFAULT_RATES.waste) return true;
  if (rates.machinePerHour !== DEFAULT_RATES.machinePerHour) return true;
  if (rates.setup !== DEFAULT_RATES.setup) return true;
  if (rates.perPart !== DEFAULT_RATES.perPart) return true;
  const metals = new Set([...Object.keys(DEFAULT_RATES.perKg), ...Object.keys(rates.perKg ?? {})]);
  for (const m of metals) if ((rates.perKg?.[m] ?? 0) !== (DEFAULT_RATES.perKg[m] ?? 0)) return true;
  return false;
}

// Fibre laser (~4 kW) cutting speed in m/min by thickness. Corten cuts like mild steel.
// Used by the shop-model override, and reported as machine time alongside the fit.
const SPEED: Record<string, [number, number][]> = {
  steel: [[0.5, 30], [1, 22], [2, 11], [3, 6], [4, 4.4], [5, 3.4], [6, 2.8], [8, 1.9], [10, 1.4], [12, 1.1]],
  aluminium: [[0.5, 35], [1, 25], [2, 12], [3, 6.5], [4, 4], [5, 2.8], [6, 2], [8, 1.2], [10, 0.8], [12, 0.6]],
};

function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

const family = (material: string) => (material === 'aluminium' ? 'aluminium' : 'steel');

/** Cutting speed in m/min. */
export const cutSpeed = (material: string, t: number) => interp(SPEED[family(material)], t);
/** Seconds per pierce, including the move to it. */
export const pierceTime = (t: number) => 0.6 + 0.12 * t * t;

const DENSITY: Record<string, number> = { steel: 7850, corten: 7850, aluminium: 2700 };

export interface PriceLine {
  label: string;
  detail: string;
  cost: number;
}

export interface PriceEstimate {
  lines: PriceLine[];
  subtotal: number; // ex VAT, parts only, before the order minimum
  net: number; // ex VAT, after the order minimum
  vat: number;
  total: number;
  minutes: number; // machine time (shop model; informational on the fit)
  sheetKg: number;
  /** Notes on what Chop Chop may not take as drawn. */
  warnings: string[];
  /** Bracing hardware included in net, ex VAT (outside the laser minimum). */
  hardware?: number;
  /** The 16 Oct 2026 per-part fit. False when a rates file selected the shop model. */
  fitted: boolean;
  /** Metres of ETCH-layer path included in the cut. */
  etchM: number;
  /** Multiplier on the qty-1 parts total. 1 for the shop model and for a tiny order. */
  orderFactor: number;
}

export interface EstimateOpts {
  /** Chop Chop prices ETCH-layer lines as cut. Default true. */
  includeEtch?: boolean;
  /**
   * True area (mm²) of the whole order, when `bom` is only one metal of a mix.
   * The order-size factor uses this so every part sees the same discount.
   */
  orderAreaMm2?: number;
}

const METAL_LABEL: Record<string, string> = { steel: 'Mild steel', corten: 'Corten', aluminium: 'Aluminium' };
const metalName = (material: string) => METAL_LABEL[material] ?? material;

function machineOf(bom: Bom, material: string, thickness: number, rates: PriceRates): { minutes: number; sheetKg: number } {
  const rho = DENSITY[material] ?? 7850;
  const bboxArea = bom.rows.reduce((a, r) => a + r.w * r.h, 0) / 1e6; // m²
  const sheetKg = bboxArea * (1 + rates.waste) * thickness * 1e-3 * rho;
  const cutMin = bom.cutLength / cutSpeed(material, thickness);
  const pierceMin = (bom.pierces * pierceTime(thickness)) / 60;
  return { minutes: (cutMin + pierceMin) * 1.1, sheetKg };
}

function rangeAndBed(material: string, thickness: number, bom: Bom): string[] {
  const warnings: string[] = [];
  const range = CHOPCHOP_RANGE[family(material)];
  if (thickness < range[0] || thickness > range[1])
    warnings.push(`Chop Chop lists ${family(material) === 'steel' ? 'mild steel' : 'aluminium'} from ${range[0]} to ${range[1]} mm; ${thickness} mm is outside that.`);
  const big = bom.rows.filter((r) => Math.max(r.w, r.h) > CHOPCHOP_BED.w || Math.min(r.w, r.h) > CHOPCHOP_BED.h);
  if (big.length) warnings.push(`${big.length} part${big.length === 1 ? ' is' : 's are'} bigger than Chop Chop’s 3 × 1.5 m bed.`);
  return warnings;
}

const mmText = (t: number) => String(Math.round(t * 100) / 100);

function estimatedWarning(material: string, thickness: number, rate: ChopRate): string | null {
  if (!rate.estimated) return null;
  const name = metalName(family(material));
  const list = rate.gauges.map(mmText).join(', ');
  if (rate.gauges.length === 1)
    return `${mmText(thickness)} mm ${name.toLowerCase()} isn’t a fitted gauge (only ${list} mm was quoted on ${CHOPCHOP_CALIBRATED}). The rate is held at that gauge and marked as an estimate.`;
  if (rate.how === 'extrapolated')
    return `${mmText(thickness)} mm ${name.toLowerCase()} is outside the fitted gauges (${list} mm). The rate is a linear extrapolation and only an estimate.`;
  return `${mmText(thickness)} mm ${name.toLowerCase()} is between the fitted gauges (${list} mm). The rate is a linear estimate.`;
}

interface Priced {
  lines: PriceLine[];
  subtotal: number;
  minutes: number;
  sheetKg: number;
  warnings: string[];
  fitted: boolean;
  etchM: number;
  partCount: number;
  orderFactor: number;
}

function applyMinimum(base: Priced, rates: PriceRates): PriceEstimate {
  const floor = base.partCount > 0 ? rates.minimum : 0;
  const charge = Math.max(0, floor - base.subtotal);
  const lines = charge > 1e-9
    ? [...base.lines, { label: 'Minimum order charge', detail: `Parts total £${base.subtotal.toFixed(2)}, order minimum £${floor.toFixed(2)} ex VAT`, cost: charge }]
    : base.lines;
  const net = base.subtotal + charge;
  const vat = net * rates.vat;
  return {
    lines,
    subtotal: base.subtotal,
    net,
    vat,
    total: net + vat,
    minutes: base.minutes,
    sheetKg: base.sheetKg,
    warnings: base.warnings,
    fitted: base.fitted,
    etchM: base.etchM,
    orderFactor: base.orderFactor,
  };
}

function rowCutMm(row: CutRow, includeEtch: boolean): number {
  return row.cut + (includeEtch ? (row.etch ?? 0) : 0);
}

function estimateFitted(bom: Bom, material: string, thickness: number, rates: PriceRates, opts: EstimateOpts): PriceEstimate {
  const includeEtch = opts.includeEtch !== false;
  const rate = chopRates(material, thickness);
  const rows = bom.rows ?? [];
  const lines: PriceLine[] = rows.map((row) => {
    const etch = row.etch ?? 0;
    const cutMm = rowCutMm(row, includeEtch);
    const detail = [
      `${(row.area / 100).toFixed(1)} cm²`,
      `${(cutMm / 1000).toFixed(2)} m cut`,
      `${row.pierces} ${row.pierces === 1 ? 'pierce' : 'pierces'}`,
    ];
    if (includeEtch && etch > 0) detail.push(`${(etch / 1000).toFixed(2)} m etch at the cut rate`);
    return { label: row.id, detail: detail.join(', '), cost: chopUnit(row.area, cutMm, row.pierces, rate.coeff) };
  });
  const areaMm2 = opts.orderAreaMm2 ?? rows.reduce((a, r) => a + r.area, 0);
  const orderFactor = orderSizeFactor(areaMm2);
  if (orderFactor !== 1) for (const line of lines) line.cost *= orderFactor;
  const etchMm = rows.reduce((a, r) => a + (r.etch ?? 0), 0);
  const warnings = [...rangeAndBed(material, thickness, bom)];
  if (rate.corten) warnings.unshift('Corten isn’t offered by Chop Chop. This estimate uses mild steel rates as a floor.');
  const estimated = estimatedWarning(material, thickness, rate);
  if (estimated) warnings.push(estimated);
  if (etchMm > 0 && includeEtch) warnings.push(`Etch adds ${(etchMm / 1000).toFixed(2)} m and is priced at the cut rate.`);
  if (etchMm > 0 && !includeEtch) warnings.push(`Etch (${(etchMm / 1000).toFixed(2)} m) is left out of this estimate. Chop Chop prices etch at the cut rate.`);
  const { minutes, sheetKg } = machineOf(bom, material, thickness, rates);
  return applyMinimum(
    { lines, subtotal: lines.reduce((a, l) => a + l.cost, 0), minutes, sheetKg, warnings, fitted: true, etchM: includeEtch ? etchMm / 1000 : 0, partCount: rows.length || bom.partCount, orderFactor },
    rates,
  );
}

function estimateShop(bom: Bom, material: string, thickness: number, rates: PriceRates): PriceEstimate {
  const { minutes, sheetKg } = machineOf(bom, material, thickness, rates);
  const perKg = rates.perKg[material] ?? rates.perKg.steel ?? 0;
  const lines: PriceLine[] = [
    { label: 'Material', detail: `${sheetKg.toFixed(1)} kg sheet at £${perKg.toFixed(2)}/kg`, cost: sheetKg * perKg },
    { label: 'Laser time', detail: `${minutes.toFixed(0)} min (${bom.cutLength.toFixed(1)} m cut, ${bom.pierces} pierces) at £${rates.machinePerHour}/h`, cost: (minutes / 60) * rates.machinePerHour },
    { label: 'Setup', detail: 'Programming and loading', cost: rates.setup },
    { label: 'Handling', detail: `${bom.partCount} parts at £${rates.perPart.toFixed(2)}`, cost: bom.partCount * rates.perPart },
  ];
  const warnings: string[] = [];
  if (material === 'corten') warnings.push('Corten isn’t listed on Chop Chop’s site (they list mild steel). Ask whether they stock it or will cut supplied sheet.');
  warnings.push(...rangeAndBed(material, thickness, bom));
  return applyMinimum(
    { lines, subtotal: lines.reduce((a, l) => a + l.cost, 0), minutes, sheetKg, warnings, fitted: false, etchM: 0, partCount: bom.partCount, orderFactor: 1 },
    rates,
  );
}

export function estimatePrice(bom: Bom, material: string, thickness: number, rates: PriceRates = DEFAULT_RATES, opts: EstimateOpts = {}): PriceEstimate {
  if (usesShopRates(rates)) return estimateShop(bom, material, thickness, rates);
  return estimateFitted(bom, material, thickness, rates, opts);
}

/**
 * Plates in more than one metal: each metal is priced on its own rates,
 * with the order minimum applied once to the lot.
 */
export function estimateMix(bom: Bom, thickness: number, rates: PriceRates = DEFAULT_RATES, opts: EstimateOpts = {}): PriceEstimate {
  const groups = bom.byMaterial?.filter((g) => g.partCount) ?? [];
  const main = bom.byMaterial?.[0]?.material ?? 'steel';
  if (groups.length <= 1) return estimatePrice(bom, groups[0]?.material ?? main, thickness, rates, opts);
  const orderAreaMm2 = opts.orderAreaMm2 ?? groups.reduce((a, g) => a + g.rows.reduce((b, r) => b + r.area, 0), 0);
  const parts = groups.map((g) => {
    const sub = { ...bom, rows: g.rows, partCount: g.partCount, cutLength: g.cutLength, pierces: g.pierces };
    return { g, est: estimatePrice(sub, g.material, thickness, { ...rates, minimum: 0 }, { ...opts, orderAreaMm2 }) };
  });
  const lines: PriceLine[] = parts.flatMap(({ g, est }) =>
    est.lines.map((l) => ({ ...l, label: est.fitted ? `${metalName(g.material)} ${l.label}` : `${metalName(g.material)} ${l.label.toLowerCase()}` })),
  );
  const warnings = [...new Set(parts.flatMap((p) => p.est.warnings))];
  return applyMinimum(
    {
      lines,
      subtotal: parts.reduce((a, p) => a + p.est.subtotal, 0),
      minutes: parts.reduce((a, p) => a + p.est.minutes, 0),
      sheetKg: parts.reduce((a, p) => a + p.est.sheetKg, 0),
      warnings,
      fitted: parts.every((p) => p.est.fitted),
      etchM: parts.reduce((a, p) => a + p.est.etchM, 0),
      partCount: bom.partCount,
      orderFactor: parts[0]?.est.orderFactor ?? 1,
    },
    rates,
  );
}

/**
 * Add the bracing hardware (rods, nuts, washers) on top of the laser estimate.
 * It is bought from a fastener supplier, so it sits outside the laser job's
 * minimum order.
 */
export function withHardware(est: PriceEstimate, rows: HardwareRow[], rates: PriceRates = DEFAULT_RATES): PriceEstimate {
  const hw = rates.hardware ?? DEFAULT_RATES.hardware;
  const sum = (kind: HardwareRow['kind'], f: (r: HardwareRow) => number) => rows.filter((r) => r.kind === kind).reduce((a, r) => a + f(r), 0);
  const metres = sum('rod', (r) => r.metres ?? 0);
  const nuts = sum('nut', (r) => r.qty);
  const washers = sum('washer', (r) => r.qty);
  const add: PriceLine[] = [];
  if (metres) add.push({ label: 'Threaded rod', detail: `${metres.toFixed(2)} m bar at £${hw.rodPerM.toFixed(2)}/m`, cost: metres * hw.rodPerM });
  if (nuts || washers)
    add.push({
      label: 'Nuts and washers',
      detail: [nuts && `${nuts} nuts at £${hw.nut.toFixed(2)}`, washers && `${washers} washers at £${hw.washer.toFixed(2)}`].filter(Boolean).join(', '),
      cost: nuts * hw.nut + washers * hw.washer,
    });
  if (!add.length) return est;
  const extra = add.reduce((a, l) => a + l.cost, 0);
  const net = est.net + extra;
  const vat = net * rates.vat;
  return { ...est, lines: [...est.lines, ...add], hardware: extra, net, vat, total: net + vat };
}

const gbp = (x: number) => `£${x.toFixed(2)}`;

/** The estimate as a plain-text sheet for the fabrication zip. */
export function priceText(est: PriceEstimate, rates: PriceRates = DEFAULT_RATES): string {
  const lines = ['Strata price estimate (not a quote)', ''];
  for (const l of est.lines) lines.push(`${l.label.padEnd(28)} ${gbp(l.cost).padStart(10)}   ${l.detail}`);
  lines.push(`${'Ex VAT'.padEnd(28)} ${gbp(est.net).padStart(10)}`);
  lines.push(`${`VAT ${Math.round(rates.vat * 100)}%`.padEnd(28)} ${gbp(est.vat).padStart(10)}`);
  lines.push(`${'Total'.padEnd(28)} ${gbp(est.total).padStart(10)}`);
  if (est.warnings.length) lines.push('', ...est.warnings.map((w) => `NOTE: ${w}`));
  lines.push('');
  if (est.fitted) {
    const off = (1 - est.orderFactor) * 100;
    lines.push(
      `Fitted to Chop Chop Laser quotes on ${CHOPCHOP_CALIBRATED}: true part area, cut length (etch included) and pierces.`,
      off >= 0.05
        ? `Order-size discount ${off.toFixed(1)}% off the qty-1 parts total, from the order’s true part area.`
        : 'Order-size discount is negligible at this part area.',
      'Delivery is not included.',
    );
  } else {
    lines.push('Laser cutting uses the shop rates from the rates file, in place of the fitted Chop Chop prices.', 'Delivery is not included.');
  }
  lines.push(`For a real price, upload laser/parts to their instant quote: ${CHOPCHOP_QUOTE_URL}`);
  return lines.join('\n') + '\n';
}
