import type { Bom } from '../core/bom';
import { DEFAULT_RATES, estimateMix, withHardware, type PriceRates } from '../core/price';

const gbp = (x: number) => `£${x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ChopChopSummaryOpts {
  includeEtch?: boolean;
  maxLen?: number;
}

/** One-line Chop Chop estimate for a collapsed inspector section. */
export function chopChopCollapsedSummary(
  bom: Bom,
  thickness: number,
  rates: PriceRates = DEFAULT_RATES,
  opts: ChopChopSummaryOpts = {},
): string {
  const maxLen = opts.maxLen ?? 52;
  const includeEtch = opts.includeEtch ?? true;
  const est = withHardware(estimateMix(bom, thickness, rates, { includeEtch }), bom.hardware, rates);
  const plates = bom.rows.length;
  const head = `${gbp(est.total)} inc VAT`;
  if (!plates) return truncate(head, maxLen);

  const per = gbp(est.total / plates);
  const candidates = [
    `${head} · ${plates} plate${plates === 1 ? '' : 's'} · ${per}/pc`,
    `${head} · ${plates} plate${plates === 1 ? '' : 's'}`,
    `${head} · ${per}/pc`,
    head,
  ];
  return truncate(candidates.find((c) => c.length <= maxLen) ?? head, maxLen);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return `${s.slice(0, max - 1)}…`;
}
