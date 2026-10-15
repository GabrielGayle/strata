// Hand moves and material picks are keyed by plate key (P3, X1, R5, L2). Keys
// are numbered from one end, so when the plate count changes the same key
// lands on a different plate. This carries each entry to the plate now standing
// where its plate stood, and drops it when no plate is left there. Changing
// slicing mode leaves them alone.
import { evaluateParams, type RawValue } from './params';
import { plateDefs, type PlateDef } from './slicer';
import type { Project } from './project';

interface Anchor {
  family: string;
  /** Position along the family: mm across the stack, mm of height, or radians round the hub. */
  pos: number;
  angular: boolean;
}

function anchorOf(d: PlateDef): Anchor {
  const { origin, normal, u } = d.plane;
  if (d.key.startsWith('R')) return { family: 'R', pos: Math.atan2(u[2], u[0]), angular: true };
  const fam = d.key.replace(/\d+$/, '');
  return { family: fam, pos: origin[0] * normal[0] + origin[1] * normal[1] + origin[2] * normal[2], angular: false };
}

function gap(a: Anchor, b: Anchor): number {
  const d = Math.abs(a.pos - b.pos);
  return a.angular ? Math.min(d, Math.PI * 2 - d) : d;
}

/** Smallest spacing between neighbours of one family (Infinity for a lone plate). */
function spacing(list: Anchor[]): number {
  let s = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) s = Math.min(s, gap(list[i], list[j]));
  return s;
}

/**
 * Old key → new key (or null: its plate is gone) for every key whose family
 * changed count. Families that kept their count keep their keys, even if the
 * plates moved (a new pitch spreads the same plates out).
 */
export function remapPlateKeys(oldDefs: PlateDef[], newDefs: PlateDef[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const group = (defs: PlateDef[]) => {
    const g = new Map<string, { key: string; a: Anchor }[]>();
    for (const d of defs) {
      const a = anchorOf(d);
      if (!g.has(a.family)) g.set(a.family, []);
      g.get(a.family)!.push({ key: d.key, a });
    }
    return g;
  };
  const before = group(oldDefs);
  const after = group(newDefs);
  for (const [fam, olds] of before) {
    const news = after.get(fam) ?? [];
    // same count: same keys. None left (another slicing mode): leave them for when it comes back
    if (news.length === olds.length || !news.length) continue;
    const tol = Math.max(spacing(olds.map((o) => o.a)), spacing(news.map((n) => n.a))) / 2 + 1e-6;
    // nearest pairs first, so two old plates can't both claim one new plate
    const pairs: { o: string; n: string; d: number }[] = [];
    for (const o of olds) for (const n of news) {
      const d = gap(o.a, n.a);
      if (d <= tol) pairs.push({ o: o.key, n: n.key, d });
    }
    pairs.sort((x, y) => x.d - y.d);
    const taken = new Set<string>();
    for (const o of olds) out.set(o.key, null);
    for (const p of pairs) {
      if (out.get(p.o) !== null || taken.has(p.n)) continue;
      out.set(p.o, p.n);
      taken.add(p.n);
    }
  }
  return out;
}

function defsFor(params: Record<string, RawValue>): PlateDef[] {
  try {
    return plateDefs(evaluateParams(params).values);
  } catch {
    return [];
  }
}

function rekey<T>(rec: Record<string, T> | undefined, map: Map<string, string | null>): { rec: Record<string, T> | undefined; moved: number; dropped: number } {
  if (!rec) return { rec, moved: 0, dropped: 0 };
  const out: Record<string, T> = {};
  let moved = 0;
  let dropped = 0;
  // untouched keys first, so a carried entry overwrites a stale one on its new plate
  for (const [k, v] of Object.entries(rec)) if (!map.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(rec)) {
    if (!map.has(k)) continue;
    const n = map.get(k);
    if (n == null) dropped++;
    else {
      out[n] = v;
      moved++;
    }
  }
  return { rec: Object.keys(out).length ? out : undefined, moved, dropped };
}

export interface RemapResult {
  project: Project;
  /** For the toast; null when nothing keyed to a plate changed. */
  message: string | null;
}

/**
 * After a settings change, keep hand moves and material picks on the plates
 * where they were made. `prev` is the project before the change, `next` after.
 */
export function keepPlatesInPlace(prev: Project, next: Project): RemapResult {
  const assign = next.appearance?.assign;
  const hasMoves = !!next.moves && Object.keys(next.moves).length > 0;
  const hasAssign = !!assign && Object.keys(assign).length > 0;
  if ((!hasMoves && !hasAssign) || prev.params === next.params) return { project: next, message: null };
  const map = remapPlateKeys(defsFor(prev.params), defsFor(next.params));
  if (!map.size) return { project: next, message: null };
  const m = rekey(next.moves, map);
  const a = rekey(assign, map);
  if (m.moved + m.dropped + a.moved + a.dropped === 0) return { project: next, message: null };
  const project: Project = {
    ...next,
    moves: m.rec,
    appearance: next.appearance && { ...next.appearance, assign: a.rec ?? {} },
  };
  const parts: string[] = [];
  if (m.moved || a.moved) parts.push(`kept ${[m.moved && `${m.moved} moved`, a.moved && `${a.moved} painted`].filter(Boolean).join(' and ')} plate${m.moved + a.moved === 1 ? '' : 's'} in place`);
  const gone = m.dropped + a.dropped;
  if (gone) parts.push(`cleared ${gone} ${gone === 1 ? 'entry whose plate is' : 'entries whose plates are'} gone`);
  return { project, message: `Plate count changed: ${parts.join('; ')} (undo to step back)` };
}
