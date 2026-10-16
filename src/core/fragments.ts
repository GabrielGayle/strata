// Sub-minimum and unsupported plate fragments: merge into a touching parent,
// drop, or keep as their own laser parts.
import { bboxOf, intersection, offset, shapeArea, unionShapes, type ExPoly } from './geom2d';
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
  if (pieces.length <= 1) return { pieces, events: [] };
  const minF = fragmentMinMm(opts.v);
  const mode = (String(opts.v.fragmentMode || 'auto') as FragmentMode) || 'auto';
  const pad = Math.max(0.2, Number(opts.v.kerf) || 0);
  const minPart = Number(opts.v.minPartSize) || 0;
  const t = Number(opts.v.thickness) || 0;

  const meta = pieces.map((ex, i) => {
    const size = pieceSize(ex);
    const anchored = opts.anchored(ex);
    const small = isSubMinimum(ex, minF);
    const unsupported = !anchored && (small || size.span < Math.max(minF, minPart, 2 * t, 5));
    return { ex, i, size, anchored, small, unsupported, fragment: small || unsupported };
  });

  const keepers = meta.filter((m) => !m.fragment);
  const frags = meta.filter((m) => m.fragment);
  if (!frags.length) return { pieces, events: [] };

  if (!keepers.length) {
    const largest = [...frags].sort((a, b) => b.size.area - a.size.area)[0];
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
        }
      } else {
        action = 'dropped';
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
    });
  }

  live.sort((a, b) => {
    const ba = bboxOf([a.outer]);
    const bb = bboxOf([b.outer]);
    return ba.minX + ba.maxX - (bb.minX + bb.maxX);
  });
  return { pieces: live, events };
}
