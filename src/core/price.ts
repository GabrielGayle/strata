// Laser cutting price estimate for Chop Chop Laser (chopchoplaser.co.uk).
// Chop Chop publishes no rates or quoting API (quotes come from their instant quote tool,
// email or phone), so this is a job-shop cost model built from the cut list: material by
// weight, machine time from cut length and pierces, plus setup and handling. Every rate is
// editable; the defaults are typical UK fibre-laser figures, not Chop Chop's own.
import type { Bom } from './bom';

export const CHOPCHOP_URL = 'https://www.chopchoplaser.co.uk/';
export const CHOPCHOP_QUOTE_URL = 'https://qm.tempustools.com/store/3bf51dae-32c7-4592-9ec5-17fea51a6558';

/** What Chop Chop lists on its site: thickness ranges per metal and a 3 m × 1.5 m bed. */
export const CHOPCHOP_RANGE: Record<string, [number, number]> = { steel: [0.5, 10], aluminium: [0.5, 5] };
export const CHOPCHOP_BED = { w: 3000, h: 1500 };

export interface PriceRates {
  /** £ per kg of sheet bought, by plate material. */
  perKg: Record<string, number>;
  /** Extra sheet charged on top of the parts' bounding boxes (offcuts, skeleton). */
  waste: number; // fraction
  machinePerHour: number; // £
  setup: number; // £ per job (programming, loading)
  perPart: number; // £ handling / deburr per part
  minimum: number; // £ minimum order
  vat: number; // fraction
}

export const DEFAULT_RATES: PriceRates = {
  perKg: { steel: 1.4, corten: 2.6, aluminium: 6.5 },
  waste: 0.25,
  machinePerHour: 90,
  setup: 25,
  perPart: 0.35,
  minimum: 40,
  vat: 0.2,
};

// Fibre laser (~4 kW) cutting speed in m/min by thickness. Corten cuts like mild steel.
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
  subtotal: number; // ex VAT, before minimum
  net: number; // ex VAT, after minimum
  vat: number;
  total: number;
  minutes: number; // machine time
  sheetKg: number;
  /** Notes on what Chop Chop may not take as drawn. */
  warnings: string[];
}

export function estimatePrice(bom: Bom, material: string, thickness: number, rates: PriceRates = DEFAULT_RATES): PriceEstimate {
  const rho = DENSITY[material] ?? 7850;
  const bboxArea = bom.rows.reduce((a, r) => a + r.w * r.h, 0) / 1e6; // m²
  const sheetKg = bboxArea * (1 + rates.waste) * thickness * 1e-3 * rho;
  const perKg = rates.perKg[material] ?? rates.perKg.steel ?? 0;

  const cutMin = bom.cutLength / cutSpeed(material, thickness);
  const pierceMin = (bom.pierces * pierceTime(thickness)) / 60;
  const minutes = (cutMin + pierceMin) * 1.1; // lead-ins and rapids

  const lines: PriceLine[] = [
    { label: 'Material', detail: `${sheetKg.toFixed(1)} kg sheet at £${perKg.toFixed(2)}/kg`, cost: sheetKg * perKg },
    { label: 'Laser time', detail: `${minutes.toFixed(0)} min (${bom.cutLength.toFixed(1)} m cut, ${bom.pierces} pierces) at £${rates.machinePerHour}/h`, cost: (minutes / 60) * rates.machinePerHour },
    { label: 'Setup', detail: 'Programming and loading', cost: rates.setup },
    { label: 'Handling', detail: `${bom.partCount} parts at £${rates.perPart.toFixed(2)}`, cost: bom.partCount * rates.perPart },
  ];
  const subtotal = lines.reduce((a, l) => a + l.cost, 0);
  const net = Math.max(subtotal, bom.partCount ? rates.minimum : 0);
  const vat = net * rates.vat;

  const warnings: string[] = [];
  if (material === 'corten') warnings.push('Corten isn’t listed on Chop Chop’s site (they list mild steel). Ask whether they stock it or will cut supplied sheet.');
  const range = CHOPCHOP_RANGE[family(material)];
  if (thickness < range[0] || thickness > range[1])
    warnings.push(`Chop Chop lists ${family(material) === 'steel' ? 'mild steel' : 'aluminium'} from ${range[0]} to ${range[1]} mm; ${thickness} mm is outside that.`);
  const big = bom.rows.filter((r) => Math.max(r.w, r.h) > CHOPCHOP_BED.w || Math.min(r.w, r.h) > CHOPCHOP_BED.h);
  if (big.length) warnings.push(`${big.length} part${big.length === 1 ? ' is' : 's are'} bigger than Chop Chop’s 3 × 1.5 m bed.`);

  return { lines, subtotal, net, vat, total: net + vat, minutes, sheetKg, warnings };
}
