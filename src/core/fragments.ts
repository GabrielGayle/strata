// Sub-minimum and unsupported plate fragments: merge into a touching parent,
// drop, or keep as their own laser parts.
import { bboxOf, difference, intersection, offset, shapeArea, shapePerimeter, unionShapes, type ExPoly, type Shape } from './geom2d';
import type { Values } from './params';

export type FragmentMode = 'auto' | 'merge' | 'drop' | 'keep';
export type FragmentAction = 'merged' | 'dropped' | 'kept';

export interface FragmentEvent {
  plateKey: string;
  plateId: string;
  /** Provisional id (S-03a) before the piece was merged or dropped. */
  pieceId: string;
  action: FragmentAction;
  reason: 'small' | 'unanchored' | 'both';
  w: number;
  h: number;
  parentId?: string;
  /** True when Merge into parent was requested (or auto chose merge) but the union was dropped. */
  mergeFallback?: boolean;
}

/** Extra width past the kerf so the gap check cannot flicker on Clipper dust. */
export const KERF_GAP_MARGIN = 0.05;

/** Morphological opening used by fit checks: drops material narrower than `mf`. */
export function morphOpen(s: Shape, mf: number): Shape {
  if (mf <= 0 || !s.length) return s;
  return offset(offset(s, -mf / 2, 'miter'), mf / 2, 'miter');
}

/** Morphological closing: fills gaps narrower than `width`. */
export function morphClose(s: Shape, width: number, join: 'miter' | 'round' = 'miter'): Shape {
  if (width <= 0 || !s.length) return s;
  return offset(offset(s, width / 2, join), -width / 2, join);
}

/**
 * Voids the kerf check reports: closing minus the original, ignoring Clipper dust. Dust along a
 * long straight edge can pass the area test, so a void must also average a micron or more across
 * (twice its area over its perimeter).
 */
export function kerfGapRegions(s: Shape, kerf: number): Shape {
  if (kerf <= 0 || !s.length) return [];
  return difference(morphClose(s, kerf), s).filter((e) => {
    const a = shapeArea([e]);
    return a > kerf * kerf * 4 && (2 * a) / shapePerimeter([e]) > GAP_DUST_WIDTH;
  });
}

/** Mean width below which a closing-minus-original sliver is rounding, not a gap (mm). */
const GAP_DUST_WIDTH = 0.005;

/** Material the min-feature check reports: original minus opening, ignoring Clipper dust. */
export function thinFeatureRegions(s: Shape, mf: number): Shape {
  if (mf <= 0 || !s.length) return [];
  return difference(s, morphOpen(s, mf)).filter((e) => shapeArea([e]) > mf * mf * 0.6);
}

function holesOf(s: Shape): Shape {
  const holes: Shape = [];
  for (const ex of s) for (const h of ex.holes) holes.push({ outer: h, holes: [] });
  return holes;
}

/**
 * Honour Small fragments mode on thin necks (not just detached slivers).
 * Does not write `minFeature` / `minFragment` — those stay the user's values.
 *
 * - keep: leave geometry (warnings remain)
 * - drop: open, which splits or removes necks below min feature
 * - merge / auto: widen thin regions so the min-feature check is clear
 */
export function repairThinNecks(
  s: Shape,
  v: { minFeature?: number; fragmentMode?: string },
): Shape {
  const mf = Number(v.minFeature) || 0;
  if (mf <= 0 || !s.length) return s;
  const mode = (String(v.fragmentMode || 'auto') as FragmentMode) || 'auto';
  if (mode === 'keep') return s;
  if (mode === 'drop') return morphOpen(s, mf);
  const thin = thinFeatureRegions(s, mf);
  if (!thin.length) return s;
  // Thicken the thin web in place (long necks are far apart as "cores").
  // Restore holes: untouched cut-outs keep their size; thin rims keep a shrunk
  // hole so the remaining material stays ≥ minFeature instead of punching the
  // original opening back and recreating the warning.
  const pad = mf / 2 + 0.05;
  let out = unionShapes(s, offset(thin, pad, 'round'));
  const holes = holesOf(s);
  if (holes.length) {
    const nearThin = offset(thin, pad + 0.2, 'round');
    const untouched: Shape = [];
    const touched: Shape = [];
    for (const h of holes) {
      if (shapeArea(intersection([h], nearThin)) > 0.01) touched.push(h);
      else untouched.push(h);
    }
    const shrunk = touched.length ? offset(touched, -pad, 'round') : [];
    const restore = [...untouched, ...shrunk];
    if (restore.length) out = difference(out, restore);
  }
  return out;
}

/**
 * Honour Small fragments mode on gaps narrower than the kerf (uncuttable slits).
 * Does not write `kerf` / `minFeature` — those stay the user's values.
 *
 * - keep: leave geometry (errors remain)
 * - drop: widen the void to ≥ kerf + margin so the laser can cut it
 * - merge / auto: close the slit (weld the sides)
 */
export function repairKerfGaps(
  s: Shape,
  v: { kerf?: number; fragmentMode?: string },
): Shape {
  const kerf = Number(v.kerf) || 0;
  if (kerf <= 0 || !s.length) return s;
  const mode = (String(v.fragmentMode || 'auto') as FragmentMode) || 'auto';
  if (mode === 'keep') return s;
  const target = kerf + KERF_GAP_MARGIN;
  const closed = morphClose(s, target);
  const gaps = difference(closed, s).filter((e) => shapeArea([e]) > kerf * kerf * 4);
  if (!gaps.length) return s;
  if (mode === 'drop') {
    const widened = difference(s, offset(gaps, target / 2, 'round'));
    return widened.filter((ex) => shapeArea([ex]) >= 0.5);
  }
  // Round join seals slits miter leaves at sharp corners (S-20 on live Neasden).
  if (!kerfGapRegions(closed, kerf).length) return closed;
  const round = morphClose(s, target, 'round');
  if (!kerfGapRegions(round, kerf).length) return round.length ? round : closed;
  const bigger = morphClose(s, target + kerf, 'round');
  return bigger.length ? bigger : round.length ? round : closed;
}

/**
 * Drop mode: trim each piece to where it sits on the layer below (glue support).
 * Auto / merge leave overhangs for `resolveFragments` to merge or drop.
 */
export function repairOverhangs(
  pieces: ExPoly[],
  below: Shape,
  v: { fragmentMode?: string },
): ExPoly[] {
  const mode = (String(v.fragmentMode || 'auto') as FragmentMode) || 'auto';
  if (mode !== 'drop' || !pieces.length || !below.length) return pieces;
  return pieces.flatMap((ex) => intersection([ex], below).filter((p) => shapeArea([p]) > 1));
}

/**
 * Kerf-gap close/widen, then thin-neck repair, on one outline.
 * Drop mode only widens kerf slits — thin necks are dropped as fragments
 * before this runs, so morphOpen must not split remaining keepers.
 * Auto/merge iterate close → thicken until both checks are empty, then a
 * final close so a last thicken cannot leave a new sub-kerf slit.
 */
export function cleanupPlateShape(
  s: Shape,
  v: { minFeature?: number; kerf?: number; fragmentMode?: string },
): Shape {
  const mode = (String(v.fragmentMode || 'auto') as FragmentMode) || 'auto';
  if (mode === 'keep' || !s.length) return s;
  let out = s;
  // set when the last kerf repair found nothing, so the final pass would too
  let gapFree = false;
  for (let i = 0; i < 6; i++) {
    const g = repairKerfGaps(out, v);
    const next = mode === 'drop' ? g : repairThinNecks(g, v);
    if (next === out) {
      gapFree = true;
      break;
    }
    out = next;
    const kerf = Number(v.kerf) || 0;
    const mf = Number(v.minFeature) || 0;
    const gapsLeft = kerf > 0 && kerfGapRegions(out, kerf).length > 0;
    const thinLeft = mode !== 'drop' && mf > 0 && thinFeatureRegions(out, mf).length > 0;
    if (!gapsLeft && !thinLeft) break;
  }
  if (mode !== 'drop' && !gapFree) out = repairKerfGaps(out, v);
  return out;
}

/**
 * Identify fragments on the original split pieces (so Auto/Drop report the
 * same sliver size as Keep, and Drop hits S-01b not morphOpen-split S-05a),
 * then clean the keepers.
 */
export function finishPlatePieces(
  pieces: ExPoly[],
  opts: {
    v: Values;
    plateKey: string;
    plateId: string;
    anchored: (ex: ExPoly) => boolean;
    below?: Shape;
    isFlat?: boolean;
    index?: number;
    /**
     * Room the plate was cut to leave for other parts (slots, holes, cavities). Widening a thin
     * neck must not grow back into it, or the plate runs into the part that goes there.
     */
    keepOut?: Shape;
  },
): { pieces: ExPoly[]; events: FragmentEvent[] } {
  let pcs = pieces.filter((ex) => shapeArea([ex]) >= 0.5);
  if (opts.isFlat && (opts.index ?? 0) > 0 && opts.below?.length) {
    pcs = repairOverhangs(pcs, opts.below, opts.v);
  }
  const resolved = resolveFragments(pcs, {
    v: opts.v,
    plateKey: opts.plateKey,
    plateId: opts.plateId,
    anchored: opts.anchored,
  });
  const keepOut = opts.keepOut?.length ? opts.keepOut : null;
  const cleaned = resolved.pieces.flatMap((ex) => {
    const out = cleanupPlateShape([ex], opts.v);
    return (keepOut ? difference(out, keepOut) : out).filter((p) => shapeArea([p]) >= 0.5);
  });
  return { pieces: cleaned, events: resolved.events };
}

export function fragmentMinMm(v: Values): number {
  const t = Number(v.thickness) || 0;
  const kerf = Number(v.kerf) || 0;
  const set = Number(v.minFragment);
  if (Number.isFinite(set) && set >= 0) return set;
  return Math.max(2 * t, 4 * kerf);
}

export function pieceSize(ex: ExPoly): { w: number; h: number; span: number; area: number } {
  const bb = bboxOf([ex.outer]);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  return { w, h, span: Math.min(w, h), area: shapeArea([ex]) };
}

export function isSubMinimum(ex: ExPoly, minFragment: number): boolean {
  if (minFragment <= 0) return false;
  const s = pieceSize(ex);
  return s.span < minFragment || s.area < minFragment * minFragment;
}

export function piecesTouch(a: ExPoly, b: ExPoly, pad: number): boolean {
  const d = Math.max(0.05, pad);
  return shapeArea(intersection(offset([a], d), offset([b], d))) > 0.01;
}

function reasonOf(small: boolean, unanchored: boolean): FragmentEvent['reason'] {
  if (small && unanchored) return 'both';
  if (unanchored) return 'unanchored';
  return 'small';
}

function letterId(base: string, i: number): string {
  return `${base}${String.fromCharCode(97 + (i % 26))}`;
}

export function formatFragment(ev: FragmentEvent): string {
  const size = `${ev.w.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} × ${ev.h.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} mm`;
  const why =
    ev.reason === 'both'
      ? ', below min fragment and does not reach the concrete'
      : ev.reason === 'unanchored'
        ? ', does not reach the concrete'
        : ', below min fragment';
  if (ev.action === 'merged') return `Merged ${ev.pieceId} (${size}${why}) into ${ev.parentId ?? ev.plateId}.`;
  if (ev.action === 'dropped' && ev.mergeFallback) {
    return `Merge into parent fell back to dropping ${ev.pieceId} (${size}${why}).`;
  }
  if (ev.action === 'dropped') return `Dropped ${ev.pieceId} (${size}${why}).`;
  return `Kept ${ev.pieceId} (${size}${why}) as a part of plate ${ev.plateId}.`;
}

export function resolveFragments(
  pieces: ExPoly[],
  opts: {
    v: Values;
    plateKey: string;
    plateId: string;
    anchored: (ex: ExPoly) => boolean;
  },
): { pieces: ExPoly[]; events: FragmentEvent[] } {
  const minF = fragmentMinMm(opts.v);
  const mode = (String(opts.v.fragmentMode || 'auto') as FragmentMode) || 'auto';
  if (pieces.length <= 1) {
    if (pieces.length === 1 && mode !== 'keep' && !opts.anchored(pieces[0])) {
      const size = pieceSize(pieces[0]);
      return {
        pieces: [],
        events: [
          {
            plateKey: opts.plateKey,
            plateId: opts.plateId,
            pieceId: letterId(opts.plateId, 0),
            action: 'dropped',
            reason: reasonOf(isSubMinimum(pieces[0], minF), true),
            w: size.w,
            h: size.h,
          },
        ],
      };
    }
    return { pieces, events: [] };
  }
  const pad = Math.max(0.2, Number(opts.v.kerf) || 0);

  const meta = pieces.map((ex, i) => {
    const size = pieceSize(ex);
    const anchored = opts.anchored(ex);
    const small = isSubMinimum(ex, minF);
    return { ex, i, size, anchored, small, fragment: small || !anchored };
  });

  const keepers = meta.filter((m) => !m.fragment);
  const frags = meta.filter((m) => m.fragment);
  if (!frags.length) return { pieces, events: [] };

  if (!keepers.length) {
    const anchoredFrags = frags.filter((f) => f.anchored);
    const pool = anchoredFrags.length ? anchoredFrags : mode === 'keep' ? frags : [];
    if (!pool.length) {
      const events: FragmentEvent[] = frags.map((f) => ({
        plateKey: opts.plateKey,
        plateId: opts.plateId,
        pieceId: letterId(opts.plateId, f.i),
        action: 'dropped' as FragmentAction,
        reason: reasonOf(f.small, !f.anchored),
        w: f.size.w,
        h: f.size.h,
      }));
      return { pieces: [], events };
    }
    const largest = [...pool].sort((a, b) => b.size.area - a.size.area)[0];
    keepers.push(largest);
    frags.splice(frags.findIndex((f) => f === largest), 1);
  }

  const live: ExPoly[] = keepers.map((k) => k.ex);
  const events: FragmentEvent[] = [];

  const touchingIndex = (ex: ExPoly): number => {
    let best = -1;
    let bestArea = -1;
    for (let i = 0; i < live.length; i++) {
      if (!piecesTouch(ex, live[i], pad)) continue;
      const a = shapeArea([live[i]]);
      if (a > bestArea) {
        bestArea = a;
        best = i;
      }
    }
    return best;
  };

  for (const f of frags) {
    const pieceId = letterId(opts.plateId, f.i);
    const want: FragmentMode = mode === 'auto' ? (touchingIndex(f.ex) >= 0 ? 'merge' : 'drop') : mode;
    let action: FragmentAction = want === 'keep' ? 'kept' : want === 'drop' ? 'dropped' : 'merged';
    let parentId: string | undefined;
    let mergeFallback = false;
    if (want === 'merge') {
      let idx = touchingIndex(f.ex);
      if (idx < 0 && mode === 'merge') {
        idx = 0;
      }
      if (idx >= 0) {
        const merged = unionShapes([live[idx]], [f.ex]);
        if (merged.length === 1) {
          live[idx] = merged[0];
          parentId = opts.plateId;
          action = 'merged';
        } else {
          action = 'dropped';
          mergeFallback = true;
        }
      } else {
        action = 'dropped';
        mergeFallback = true;
      }
    } else if (want === 'keep') {
      live.push(f.ex);
      action = 'kept';
    } else {
      action = 'dropped';
    }
    events.push({
      plateKey: opts.plateKey,
      plateId: opts.plateId,
      pieceId,
      action,
      reason: reasonOf(f.small, !f.anchored),
      w: f.size.w,
      h: f.size.h,
      parentId,
      ...(mergeFallback ? { mergeFallback: true } : {}),
    });
  }

  live.sort((a, b) => {
    const ba = bboxOf([a.outer]);
    const bb = bboxOf([b.outer]);
    return ba.minX + ba.maxX - (bb.minX + bb.maxX);
  });
  return { pieces: live, events };
}
