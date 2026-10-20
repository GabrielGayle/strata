// Laser suppliers the price estimate can be set to.
//
// Only Chop Chop has a calibrated price model (chopchopRates.ts). Unicorn and
// Cut It Out are priced on that fit as a proxy, then given their own minimum
// order, VAT and gauge list. Their part prices are estimates until enough of
// their quotes are in to fit them. Facts were noted on 20 Oct 2026 from the
// ECTYPE supplier notes; anything not checked against a live quote is marked
// `confirmed: false` and shown as unconfirmed.

export type SupplierId = 'chopchop' | 'unicorn' | 'cutitout';

export interface SupplierProfile {
  id: SupplierId;
  name: string;
  /** Website, when checked. */
  url?: string;
  /** Instant-quote page, when there is one. */
  quoteUrl?: string;
  /** Order minimum, £ ex VAT. */
  minimum: number;
  /** 'order' applies the minimum once; 'gauge' applies it to each material and thickness. */
  minimumPer: 'order' | 'gauge';
  /** False when the supplier doesn't charge VAT. */
  chargesVat: boolean;
  /** How the supplier shows prices on its quote tool. */
  shows: 'ex VAT' | 'inc VAT' | 'no VAT';
  /** Thicknesses (mm) the supplier cuts, by metal. A metal not listed hasn't been checked. */
  gauges?: Partial<Record<string, number[]>>;
  /** Thickness range (mm) the supplier lists, by metal, when it isn't a fixed gauge list. */
  range?: Partial<Record<string, [number, number]>>;
  corten: boolean | 'unchecked';
  lead: string;
  /** Volume discount as listed. Not applied on top of the proxy (see priceNote). */
  volume?: { fromParts: number; minPct: number; maxPct: number };
  /** True when parts are priced on the Chop Chop fit, not the supplier's own prices. */
  proxy: boolean;
  /** False when the minimum, VAT or gauges haven't been checked against a live quote. */
  confirmed: boolean;
}

export const SUPPLIERS: Record<SupplierId, SupplierProfile> = {
  chopchop: {
    id: 'chopchop',
    name: 'Chop Chop Laser',
    url: 'https://www.chopchoplaser.co.uk/',
    quoteUrl: 'https://qm.tempustools.com/store/3bf51dae-32c7-4592-9ec5-17fea51a6558',
    minimum: 55,
    minimumPer: 'order',
    chargesVat: true,
    shows: 'ex VAT',
    range: { steel: [0.5, 10], aluminium: [0.5, 5] },
    corten: false,
    lead: '3 working days',
    proxy: false,
    confirmed: true,
  },
  unicorn: {
    id: 'unicorn',
    name: 'Unicorn Sheet Metal Works',
    // £60 inc VAT on the quote tool, per material and thickness
    minimum: 50,
    minimumPer: 'gauge',
    chargesVat: true,
    shows: 'inc VAT',
    gauges: { steel: [1.5, 2, 3] },
    corten: 'unchecked',
    lead: '6 working days posted, 4 collected (orders under £2.5k)',
    volume: { fromParts: 50, minPct: 2.5, maxPct: 15 },
    proxy: true,
    confirmed: true,
  },
  cutitout: {
    id: 'cutitout',
    name: 'Cut It Out',
    minimum: 20,
    minimumPer: 'order',
    chargesVat: false,
    shows: 'no VAT',
    corten: 'unchecked',
    lead: '1–2 days',
    proxy: true,
    confirmed: false,
  },
};

export const SUPPLIER_IDS = Object.keys(SUPPLIERS) as SupplierId[];

export function isSupplierId(x: unknown): x is SupplierId {
  return typeof x === 'string' && (SUPPLIER_IDS as string[]).includes(x);
}

export function supplierOf(id: SupplierId | undefined): SupplierProfile {
  return SUPPLIERS[id ?? 'chopchop'] ?? SUPPLIERS.chopchop;
}

const METAL: Record<string, string> = { steel: 'mild steel', aluminium: 'aluminium', corten: 'Corten' };
const mmText = (t: number) => String(Math.round(t * 100) / 100);

/**
 * What the supplier can't cut as drawn: a thickness off its gauge list or range,
 * or a metal it doesn't stock. Empty when it can, or when nothing is known.
 */
export function supplierCutWarnings(s: SupplierProfile, material: string, thickness: number): string[] {
  const out: string[] = [];
  if (material === 'corten') {
    if (s.corten === false) out.push(`Corten isn’t offered by ${s.name}.`);
    else if (s.corten === 'unchecked') out.push(`Corten at ${s.name} hasn’t been checked (unconfirmed).`);
  }
  const family = material === 'aluminium' ? 'aluminium' : 'steel';
  const gauges = s.gauges?.[family];
  if (gauges && !gauges.some((g) => Math.abs(g - thickness) < 1e-6))
    out.push(`${s.name} cuts ${METAL[family]} in ${gauges.map(mmText).join(', ')} mm only. ${mmText(thickness)} mm can’t be cut there.`);
  const range = s.range?.[family];
  if (range && (thickness < range[0] || thickness > range[1]))
    out.push(`${s.name} lists ${METAL[family]} from ${range[0]} to ${range[1]} mm; ${mmText(thickness)} mm is outside that.`);
  return out;
}

/** One line on how far to trust a supplier's figures. */
export function supplierPriceNote(s: SupplierProfile): string {
  const bits: string[] = [];
  if (s.proxy) bits.push(`Part prices are est.: the Chop Chop fit is used as a proxy until ${s.name} quotes are fitted.`);
  const min = s.shows === 'inc VAT' ? `£${(s.minimum * 1.2).toFixed(0)} inc VAT` : `£${s.minimum.toFixed(0)}${s.chargesVat ? ' ex VAT' : ''}`;
  bits.push(`Minimum ${min}${s.minimumPer === 'gauge' ? ' per material and thickness' : ''}${s.chargesVat ? '' : ', no VAT'}${s.confirmed ? '' : ' (unconfirmed)'}.`);
  if (s.volume)
    bits.push(`${s.name} lists ${s.volume.minPct}–${s.volume.maxPct}% off from ${s.volume.fromParts} parts; it isn’t taken off again, since the proxy already carries Chop Chop’s order-size discount.`);
  bits.push(`Lead time ${s.lead}${s.confirmed ? '' : ' (unconfirmed)'}.`);
  return bits.join(' ');
}
