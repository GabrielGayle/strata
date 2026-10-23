import type { Bom } from '../core/bom';
import { DEFAULT_RATES, fullEstimate, type PriceRates } from '../core/price';

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
  const est = fullEstimate(bom, thickness, rates, opts.includeEtch == null ? {} : { includeEtch: opts.includeEtch });
  const plates = bom.rows.length;
  const head = est.labour ? `${gbp(est.allIn)} all in` : `${gbp(est.total)} ${est.vat > 0 ? 'inc VAT' : 'no VAT'}`;
  if (!plates) return truncate(head, maxLen);

  const platesBit = `${plates} plate${plates === 1 ? '' : 's'}`;
  const per = gbp(est.total / plates);
  const candidates = [
    `${head} · ${platesBit}`,
    head,
    `${head} · ${platesBit} · ${per}/pc`,
    `${head} · ${per}/pc`,
  ];
  return truncate(candidates.find((c) => c.length <= maxLen) ?? head, maxLen);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return `${s.slice(0, max - 1)}…`;
}
