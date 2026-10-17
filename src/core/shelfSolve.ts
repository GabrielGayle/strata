// Unobstructed-view solver: nudge postcard-shelf placement so every face shows
// from the chosen angle, changing the user's numbers as little as possible and
// never those they typed themselves.
import { toWorld, type Frame } from './origin';
import { shelfCards, SHELF_SOLVE_KEYS, type ShelfSolveKey, type ShelfSpec } from './shelf';
import { cardVisibility, viewSettings, type VisibilityReport } from './shelfView';

export interface SolveResult {
  spec: ShelfSpec;
  report: VisibilityReport;
  /** True when at least one placement number moved from the user's value. */
  adjusted: boolean;
}

const SCALES: Record<ShelfSolveKey, number> = {
  radius: 20,
  gap: 1,
  rows: 1,
  rowStep: 10,
  rowRise: 10,
  seat: 2,
  lean: 1,
  lift: 8,
  shoulder: 2,
};

const BOUNDS: Record<ShelfSolveKey, { lo: number; hi: number; step: number }> = {
  radius: { lo: 80, hi: 1400, step: 10 },
  gap: { lo: 0, hi: 80, step: 1 },
  rows: { lo: 1, hi: 12, step: 1 },
  rowStep: { lo: 0, hi: 250, step: 5 },
  rowRise: { lo: -100, hi: 250, step: 5 },
  seat: { lo: 1, hi: 40, step: 1 },
  lean: { lo: -20, hi: 30, step: 1 },
  lift: { lo: 0, hi: 240, step: 5 },
  shoulder: { lo: 0, hi: 40, step: 1 },
};

function clampKey(key: ShelfSolveKey, x: number) {
  const b = BOUNDS[key];
  const v = Math.min(b.hi, Math.max(b.lo, x));
  return key === 'rows' ? Math.round(v) : v;
}

function freeKeys(spec: ShelfSpec): ShelfSolveKey[] {
  const locked = spec.overrides ?? {};
  const useful: ShelfSolveKey[] =
    spec.layout === 'arch' || spec.layout === 'fan'
      ? ['gap', 'lean', 'radius', 'lift', 'seat']
      : spec.layout === 'bands'
        ? ['gap', 'lean', 'radius', 'rowStep', 'rowRise', 'lift', 'seat']
        : ['gap', 'lean', 'radius', 'rowStep', 'rowRise', 'lift', 'seat'];
  return useful.filter((k) => !locked[k]);
}

function deltaCost(from: ShelfSpec, to: ShelfSpec, keys: ShelfSolveKey[]) {
  let s = 0;
  for (const k of keys) {
    const d = (Number(to[k]) - Number(from[k])) / SCALES[k];
    s += d * d;
  }
  return s;
}

function score(report: VisibilityReport, from: ShelfSpec, to: ShelfSpec, keys: ShelfSolveKey[]) {
  const area = report.cards.reduce((a, c) => a + (c.over ? c.hiddenArea : 0), 0);
  return report.hiddenCount * 1e6 + area + deltaCost(from, to, keys);
}

function placed(spec: ShelfSpec, baseTop: number, origin?: Frame) {
  const cards = shelfCards(spec, baseTop);
  return origin ? cards.map((c) => toWorld(c, origin, true)) : cards;
}

function evaluate(spec: ShelfSpec, baseTop: number, origin?: Frame): VisibilityReport {
  return cardVisibility(placed(spec, baseTop, origin), viewSettings(spec));
}

function setKey(spec: ShelfSpec, key: ShelfSolveKey, value: number): ShelfSpec {
  return { ...spec, [key]: clampKey(key, value) };
}

/**
 * Search nearby placement values. Prefer the smallest change that reaches
 * 0 hidden cards; if none does, keep the closest (fewest hidden, then least
 * hidden area, then least param movement).
 */
export function solveUnobstructed(spec: ShelfSpec, baseTop: number, origin?: Frame): SolveResult {
  const view: ShelfSpec = { ...spec, unobstructed: true };
  const keys = freeKeys(view);
  const start = evaluate(view, baseTop, origin);
  if (start.hiddenCount === 0 || !keys.length) {
    return { spec, report: start, adjusted: false };
  }

  let bestSpec: ShelfSpec = view;
  let bestReport = start;
  let best = score(start, spec, view, keys);

  const consider = (next: ShelfSpec) => {
    const report = evaluate(next, baseTop, origin);
    const s = score(report, spec, next, keys);
    if (s + 1e-9 < best) {
      best = s;
      bestSpec = next;
      bestReport = report;
      return true;
    }
    return false;
  };

  // Pattern search: try each free axis, growing steps, both directions.
  for (let round = 0; round < 6; round++) {
    let moved = false;
    for (const key of keys) {
      const step0 = BOUNDS[key].step;
      for (const mag of [1, 2, 4, 8, 16]) {
        for (const dir of [1, -1]) {
          const cur = Number(bestSpec[key]);
          const next = setKey(bestSpec, key, cur + dir * mag * step0);
          if (next[key] === bestSpec[key]) continue;
          if (consider(next)) moved = true;
        }
      }
    }
    if (bestReport.hiddenCount === 0) break;
    if (!moved) break;
  }

  // Drop unused optional flags we didn't mean to add (keep the user's file shape).
  const out: ShelfSpec = { ...spec };
  let adjusted = false;
  for (const k of SHELF_SOLVE_KEYS) {
    if (out[k] !== bestSpec[k]) {
      (out as unknown as Record<string, number>)[k] = Number(bestSpec[k]);
      adjusted = true;
    }
  }
  const report = adjusted ? evaluate(out, baseTop, origin) : start;
  return { spec: adjusted ? out : spec, report, adjusted };
}

/** Place shelf cards, running the unobstructed solver first when it is on. */
export function layoutShelf(spec: ShelfSpec | undefined, baseTop: number, origin?: Frame) {
  if (!spec?.unobstructed) return shelfCards(spec, baseTop);
  const { spec: solved } = solveUnobstructed(spec, baseTop, origin);
  return shelfCards(solved, baseTop);
}
