// Nesting parts onto sheets. `nest` lays each part's real outline into a column
// skyline (so a plate's wavy top takes the next plate's wavy bottom, turned 180°),
// keeps the best of a few orderings, and never returns worse than the bounding-box
// skyline Strata always had (`nestBoxes`). With a time budget it keeps trying
// shuffled orderings until the budget runs out: the cloud's tight nest is this
// same function with 30 or 90 seconds.

import { offset, simplifyPath, type Path, type Vec2 } from './geom2d';


export interface NestItem {
  id: string;
  w: number;
  h: number;
  area: number;
  /** Outer rings in part coordinates (bbox min at minX/minY). Without it the part nests as its bbox. */
  outline?: Path[];
  minX?: number;
  minY?: number;
}

export interface Placement {
  id: string;
  x: number; // position of the (possibly rotated) bbox min corner on the sheet
  y: number;
  w: number;
  h: number;
  rot: boolean; // rotated 90° CCW (or 270° when turn is 3)
  /** Quarter turns CCW, 0..3. Absent means 1 when rot, else 0. */
  turn?: Turn;
}

export type Turn = 0 | 1 | 2 | 3;

export function turnOf(pl: Pick<Placement, 'rot' | 'turn'>): Turn {
  return pl.turn ?? (pl.rot ? 1 : 0);
}

/**
 * Part coordinates to sheet coordinates for a placement. `bb` is the part's bbox;
 * the turned bbox's min corner lands on (x, y).
 */
export function placeTransform(bb: { minX: number; minY: number; maxX: number; maxY: number }, pl: Pick<Placement, 'x' | 'y' | 'rot' | 'turn'>): (p: Vec2) => Vec2 {
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  const t = turnOf(pl);
  return (p: Vec2): Vec2 => {
    const lx = p[0] - bb.minX;
    const ly = p[1] - bb.minY;
    if (t === 0) return [pl.x + lx, pl.y + ly];
    if (t === 1) return [pl.x + (h - ly), pl.y + lx];
    if (t === 2) return [pl.x + (w - lx), pl.y + (h - ly)];
    return [pl.x + ly, pl.y + (w - lx)];
  };
}

export interface NestSheet {
  index: number;
  placements: Placement[];
  used: number; // part area placed
  /** Metal on this sheet, when the plates mix metals (each is cut on its own sheets). */
  material?: string;
  /** Sheet thickness, when it isn't the plates' (the steel base plate's own sheet). */
  thickness?: number;
}

export interface NestResult {
  sheets: NestSheet[];
  unplaced: string[];
  sheetW: number;
  sheetH: number;
  utilisation: number;
  /** Which nester won: bounding boxes or outlines. */
  method?: 'box' | 'outline';
  /** Gap kept between parts and from the sheet edge. */
  spacing?: number;
  /** Orderings tried. */
  tries?: number;
  /** 'saved' when this is the project's saved (cloud) nest rather than one made just now. */
  source?: 'saved';
}

interface Sky {
  x: number;
  y: number;
  w: number;
}

class SkylineSheet {
  sky: Sky[];
  constructor(public W: number, public H: number) {
    this.sky = [{ x: 0, y: 0, w: W }];
  }
  find(w: number, h: number): { x: number; y: number; idx: number } | null {
    let best: { x: number; y: number; idx: number } | null = null;
    for (let i = 0; i < this.sky.length; i++) {
      const x = this.sky[i].x;
      if (x + w > this.W + 1e-9) break;
      let y = 0;
      let rem = w;
      for (let j = i; j < this.sky.length && rem > 1e-9; j++) {
        y = Math.max(y, this.sky[j].y);
        rem -= this.sky[j].w;
      }
      if (y + h > this.H + 1e-9) continue;
      if (!best || y < best.y - 1e-9 || (Math.abs(y - best.y) < 1e-9 && x < best.x)) best = { x, y, idx: i };
    }
    return best;
  }
  place(x: number, y: number, w: number, h: number) {
    const top = y + h;
    const next: Sky[] = [];
    for (const s of this.sky) {
      const s0 = s.x, s1 = s.x + s.w;
      if (s1 <= x + 1e-9 || s0 >= x + w - 1e-9) {
        next.push(s);
        continue;
      }
      if (s0 < x) next.push({ x: s0, y: s.y, w: x - s0 });
      if (s1 > x + w) next.push({ x: x + w, y: s.y, w: s1 - (x + w) });
    }
    next.push({ x, y: top, w });
    next.sort((a, b) => a.x - b.x);
    const merged: Sky[] = [];
    for (const s of next) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.y - s.y) < 1e-9 && Math.abs(last.x + last.w - s.x) < 1e-6) last.w += s.w;
      else merged.push({ ...s });
    }
    this.sky = merged;
  }
}

/** Skyline bottom-left nesting of part bounding boxes: the nester Strata always had, kept as a floor. */
export function nestBoxes(items: NestItem[], sheetW: number, sheetH: number, spacing: number): NestResult {
  const W = sheetW - spacing;
  const H = sheetH - spacing;
  const sorted = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.area - a.area);
  const sheets: { sk: SkylineSheet; out: NestSheet }[] = [];
  const unplaced: string[] = [];
  for (const it of sorted) {
    const opts = [
      { w: it.w + spacing, h: it.h + spacing, rot: false },
      { w: it.h + spacing, h: it.w + spacing, rot: true },
    ];
    let done = false;
    const tryOn = (s: { sk: SkylineSheet; out: NestSheet }) => {
      let best: { x: number; y: number; o: (typeof opts)[0] } | null = null;
      for (const o of opts) {
        const f = s.sk.find(o.w, o.h);
        if (f && (!best || f.y + o.h < best.y + best.o.h - 1e-9)) best = { x: f.x, y: f.y, o };
      }
      if (!best) return false;
      s.sk.place(best.x, best.y, best.o.w, best.o.h);
      s.out.placements.push({ id: it.id, x: best.x + spacing, y: best.y + spacing, w: best.o.w - spacing, h: best.o.h - spacing, rot: best.o.rot });
      s.out.used += it.area;
      return true;
    };
    for (const s of sheets) if (tryOn(s)) { done = true; break; }
    if (!done) {
      const s = { sk: new SkylineSheet(W, H), out: { index: sheets.length, placements: [], used: 0 } as NestSheet };
      if (tryOn(s)) {
        sheets.push(s);
        done = true;
      }
    }
    if (!done) unplaced.push(it.id);
  }
  const used = sheets.reduce((a, s) => a + s.out.used, 0);
  return {
    sheets: sheets.map((s) => s.out),
    unplaced,
    sheetW,
    sheetH,
    utilisation: sheets.length ? used / (sheets.length * sheetW * sheetH) : 0,
  };
}


/** Column width of the outline skyline, mm. Every place a part can go is on this grid. */
export const NEST_COLUMN_MM = 2;

/** Columns skipped in the first sweep over a sheet; the best of those is then searched column by column. */
const STRIDE = 4;

/** Parts this full of their bounding boxes nest as boxes in the quick nest. */
const RECT_FILL = 0.9;

export interface NestOptions {
  /** Keep trying shuffled orderings for this long (ms). 0: the deterministic tries only. */
  budgetMs?: number;
  /** Seed for the shuffles, so a budgeted run can be repeated. */
  seed?: number;
  /** Stop after this many tries in all (deterministic runs for tests). */
  maxTries?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** One turn of a part, as columns: lowest and highest point of the grown outline in each. */
interface Profile {
  turn: Turn;
  w: number; // turned bbox
  h: number;
  cols: number;
  lo: Float64Array;
  hi: Float64Array;
  top: number; // max of hi
}

interface Prepared {
  item: NestItem;
  /** Distinct turns, for the search. */
  profiles: Profile[];
  /** All four turns, by turn. */
  byTurn: Profile[];
}

function turnPoint(t: Turn, w: number, h: number, lx: number, ly: number): Vec2 {
  if (t === 0) return [lx, ly];
  if (t === 1) return [h - ly, lx];
  if (t === 2) return [w - lx, h - ly];
  return [ly, w - lx];
}

/**
 * Lowest and highest y of a polygon set in each column [x0 + c·r, x0 + (c+1)·r], exactly:
 * a polygon's extent over a strip is reached on its boundary, so clipping each edge to
 * each column it crosses is enough.
 */
function columnExtents(rings: Path[], x0: number, r: number, cols: number): { lo: Float64Array; hi: Float64Array } {
  const lo = new Float64Array(cols).fill(Infinity);
  const hi = new Float64Array(cols).fill(-Infinity);
  const hit = (c: number, y: number) => {
    if (c < 0 || c >= cols) return;
    if (y < lo[c]) lo[c] = y;
    if (y > hi[c]) hi[c] = y;
  };
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const xa = a[0] - x0;
      const xb = b[0] - x0;
      const lx = Math.min(xa, xb);
      const ux = Math.max(xa, xb);
      const c0 = Math.floor(lx / r);
      const c1 = Math.floor(ux / r);
      if (ux - lx < 1e-12) {
        hit(c0, a[1]);
        hit(c0, b[1]);
        continue;
      }
      const yAt = (x: number) => a[1] + ((b[1] - a[1]) * (x - xa)) / (xb - xa);
      for (let c = c0; c <= c1; c++) {
        const s = Math.max(lx, c * r);
        const e = Math.min(ux, (c + 1) * r);
        hit(c, yAt(s));
        hit(c, yAt(e));
      }
    }
  }
  return { lo, hi };
}

/** Arc tolerance of the grown outline; the growth is this much more than half the gap, so chords never cut the gap short. */
const GROW_ARC_TOL = 0.2;

/** How far each outline grows for a gap. */
const growBy = (gap: number) => (gap > 0 ? gap / 2 + GROW_ARC_TOL + SIMPLIFY_TOL : 0);

/** Outlines are thinned to this before growing (and grown this much more to make up for it). */
const SIMPLIFY_TOL = 0.1;

function prepare(item: NestItem, gap: number, r: number): Prepared {
  const box: Path = [[0, 0], [item.w, 0], [item.w, item.h], [0, item.h]];
  const outline = item.outline?.length ? item.outline : null;
  const mx = outline ? item.minX ?? 0 : 0;
  const my = outline ? item.minY ?? 0 : 0;
  const rings: Path[] = (outline ?? [box]).map((ring) => ring.map(([x, y]) => [x - mx, y - my] as Vec2));
  // grow once by half the gap, so two grown outlines touching are a whole gap apart;
  // turning the grown outline is the same as growing the turned one
  const G = growBy(gap);
  const thin = rings.map((ring) => simplifyPath(ring, SIMPLIFY_TOL));
  const grownRings = G > 0 ? offset(thin.map((outer) => ({ outer, holes: [] })), G, 'round', GROW_ARC_TOL).map((e) => e.outer) : rings;
  const profiles: Profile[] = [];
  const byTurn: Profile[] = [];
  const seen = new Set<string>();
  for (const turn of [0, 1, 2, 3] as Turn[]) {
    const odd = turn % 2 === 1;
    const w = odd ? item.h : item.w;
    const h = odd ? item.w : item.h;
    const turned = grownRings.map((ring) => ring.map(([x, y]) => turnPoint(turn, item.w, item.h, x, y)));
    const cols = Math.max(1, Math.ceil((w + 2 * G) / r - 1e-9));
    const { lo, hi } = columnExtents(turned, -G, r, cols);
    let top = -Infinity;
    for (let c = 0; c < cols; c++) if (hi[c] > top) top = hi[c];
    const pr: Profile = { turn, w, h, cols, lo, hi, top };
    byTurn.push(pr);
    // a symmetric part turned 180° is the same part: skip the repeat
    const sig = `${odd}:${Array.from(lo, (v) => v.toFixed(2)).join(',')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    profiles.push(pr);
  }
  return { item, profiles, byTurn };
}

type Score = 'low' | 'snug';

interface SkySheet {
  sky: Float64Array;
  out: NestSheet;
  top: number;
}

/** Lay prepared parts in this order onto sheets, first sheet that takes each. */
function outlinePass(order: Prepared[], sheetW: number, sheetH: number, gap: number, r: number, score: Score): NestResult {
  const g = gap / 2;
  const G = growBy(gap);
  const K = Math.max(0, Math.floor((sheetW - 2 * g) / r + 1e-9));
  const yMax = sheetH - g; // grown outline top limit
  const sheets: SkySheet[] = [];
  const unplaced: string[] = [];
  const newSheet = (): SkySheet => ({ sky: new Float64Array(K).fill(g), out: { index: sheets.length, placements: [], used: 0 }, top: 0 });
  const tryOn = (s: SkySheet, p: Prepared): boolean => {
    let best: { k: number; y: number; pr: Profile; v: number } | null = null;
    const sky = s.sky;
    // score of the part at column k, or Infinity when it doesn't fit or can't beat `bound`
    const at = (pr: Profile, k: number, bound: number): { y: number; v: number } | null => {
      const { cols, lo, top } = pr;
      const cap = Math.min(yMax, score === 'low' ? bound : Infinity) - top;
      let y = -Infinity;
      for (let c = 0; c < cols; c++) {
        const v = sky[k + c] - lo[c];
        if (v > y) {
          y = v;
          if (y > cap + 1e-9) return null;
        }
      }
      if (score === 'low') return { y, v: y + top + k * 1e-7 };
      // area left empty under the part, then how high it reaches
      let waste = 0;
      for (let c = 0; c < cols; c++) if (lo[c] !== Infinity) waste += y + lo[c] - sky[k + c];
      return { y, v: waste * r + (y + top) * 4 + k * 1e-7 };
    };
    for (const pr of p.profiles) {
      const last = K - pr.cols;
      if (last < 0) continue;
      // every STRIDE-th column first, then the columns around the best of those
      let coarse: { k: number; v: number } | null = null;
      for (let k = 0; k <= last; k = k < last && k + STRIDE > last ? last : k + STRIDE) {
        const e = at(pr, k, best?.v ?? Infinity);
        if (e && (!coarse || e.v < coarse.v)) coarse = { k, v: e.v };
        if (e && (!best || e.v < best.v)) best = { k, y: e.y, pr, v: e.v };
        if (k === last) break;
      }
      if (!coarse) continue;
      for (let k = Math.max(0, coarse.k - STRIDE + 1); k <= Math.min(last, coarse.k + STRIDE - 1); k++) {
        const e = at(pr, k, best?.v ?? Infinity);
        if (e && (!best || e.v < best.v)) best = { k, y: e.y, pr, v: e.v };
      }
    }
    if (!best) return false;
    const { k, y, pr } = best;
    for (let c = 0; c < pr.cols; c++) {
      const t = y + pr.hi[c];
      if (t > sky[k + c]) sky[k + c] = t;
    }
    s.top = Math.max(s.top, y + pr.h);
    // sheet columns start g in from the edge; the grown outline's columns start G left of the part's turned bbox
    s.out.placements.push({ id: p.item.id, x: g + G + k * r, y, w: pr.w, h: pr.h, rot: pr.turn % 2 === 1, turn: pr.turn });
    s.out.used += p.item.area;
    return true;
  };
  for (const p of order) {
    let done = false;
    for (const s of sheets) if (tryOn(s, p)) { done = true; break; }
    if (!done) {
      const s = newSheet();
      if (tryOn(s, p)) {
        sheets.push(s);
        done = true;
      }
    }
    if (!done) unplaced.push(p.item.id);
  }
  const used = sheets.reduce((a, s) => a + s.out.used, 0);
  return {
    sheets: sheets.map((s) => s.out),
    unplaced,
    sheetW,
    sheetH,
    utilisation: sheets.length ? used / (sheets.length * sheetW * sheetH) : 0,
    method: 'outline',
  };
}


/** A part inside a pair: where its turned bbox sits in the pair's coordinates, and its turn. */
interface Member {
  item: NestItem;
  x: number;
  y: number;
  turn: Turn;
}

interface Units {
  items: NestItem[];
  members: Map<string, Member[]>;
}

/**
 * Pair parts up, the second turned 180° against the first, so a plate's wavy edge takes
 * the next plate's wavy edge (two terrain profiles top to top). Each part is tried with
 * the `window` parts nearest it in width; a pair is kept only when it saves at least
 * `minSave` of the two bounding boxes. Gaps are kept with the grown-outline columns,
 * the same test the sheet skyline uses.
 */
function pairUp(items: NestItem[], prep: (it: NestItem) => Prepared, r: number, window: number, minSave: number): Units {
  const byW = [...items].filter((it) => it.outline?.length).sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
  type Cand = { save: number; a: NestItem; b: NestItem; ta: Turn; j: number; dy: number };
  const cands: Cand[] = [];
  for (let i = 0; i < byW.length; i++) {
    const A = prep(byW[i]);
    for (let n = i + 1; n < Math.min(byW.length, i + 1 + window); n++) {
      const B = prep(byW[n]);
      for (const ta of [0, 1] as Turn[]) {
        const pa = A.byTurn[ta];
        const pb = B.byTurn[(ta + 2) as Turn];
        const minOverlap = Math.ceil(Math.min(pa.cols, pb.cols) * 0.6);
        let bestHere = null as Cand | null;
        const boxes = pa.w * pa.h + pb.w * pb.h;
        const at = (j: number) => {
          // B's column c sits over A's column c + j
          let dy = -Infinity;
          const c0 = Math.max(0, -j);
          const c1 = Math.min(pb.cols, pa.cols - j);
          for (let c = c0; c < c1; c++) {
            const v = pa.hi[c + j] - pb.lo[c];
            if (v > dy) dy = v;
          }
          if (dy === -Infinity) return;
          const bx = j * r;
          const w = Math.max(pa.w, bx + pb.w) - Math.min(0, bx);
          const h = Math.max(pa.h, dy + pb.h) - Math.min(0, dy);
          const save = (boxes - w * h) / boxes;
          if (!bestHere || save > bestHere.save) bestHere = { save, a: A.item, b: B.item, ta, j, dy };
        };
        // every STRIDE-th offset, then each offset around the best
        const j0 = minOverlap - pb.cols;
        const j1 = pa.cols - minOverlap;
        for (let j = j0; j <= j1; j += STRIDE) at(j);
        if (bestHere) {
          const jb = (bestHere as Cand).j;
          for (let j = Math.max(j0, jb - STRIDE + 1); j <= Math.min(j1, jb + STRIDE - 1); j++) if (j !== jb) at(j);
        }
        if (bestHere && bestHere.save >= minSave) cands.push(bestHere);
      }
    }
  }
  cands.sort((x, y) => y.save - x.save);
  const used = new Set<string>();
  const out: NestItem[] = [];
  const members = new Map<string, Member[]>();
  for (const c of cands) {
    if (used.has(c.a.id) || used.has(c.b.id)) continue;
    used.add(c.a.id);
    used.add(c.b.id);
    const pa = prep(c.a).byTurn[c.ta];
    const tb = ((c.ta + 2) % 4) as Turn;
    const pb = prep(c.b).byTurn[tb];
    const ms: Member[] = [
      { item: c.a, x: 0, y: 0, turn: c.ta },
      { item: c.b, x: c.j * r, y: c.dy, turn: tb },
    ];
    const rings: Path[] = [];
    for (const m of ms) {
      const bb = { minX: m.item.minX ?? 0, minY: m.item.minY ?? 0, maxX: (m.item.minX ?? 0) + m.item.w, maxY: (m.item.minY ?? 0) + m.item.h };
      const f = placeTransform(bb, { ...m, rot: m.turn % 2 === 1 });
      for (const ring of m.item.outline!) rings.push(ring.map(f));
    }
    const minX = Math.min(0, ms[1].x);
    const minY = Math.min(0, ms[1].y);
    const id = `\u0000pair:${c.a.id}+${c.b.id}`;
    out.push({
      id,
      w: Math.max(pa.w, ms[1].x + pb.w) - minX,
      h: Math.max(pa.h, ms[1].y + pb.h) - minY,
      area: c.a.area + c.b.area,
      outline: rings,
      minX,
      minY,
    });
    members.set(id, ms);
  }
  for (const it of items) if (!used.has(it.id)) out.push(it);
  return { items: out, members };
}

/** Swap each pair's placement for the placements of its two parts. */
function expandPairs(r: NestResult, units: Units): NestResult {
  if (!units.members.size) return r;
  const unitById = new Map(units.items.map((u) => [u.id, u]));
  const unplaced: string[] = [];
  for (const id of r.unplaced) {
    const ms = units.members.get(id);
    if (ms) unplaced.push(...ms.map((m) => m.item.id));
    else unplaced.push(id);
  }
  const sheets = r.sheets.map((s) => ({
    ...s,
    placements: s.placements.flatMap((pl): Placement[] => {
      const ms = units.members.get(pl.id);
      if (!ms) return [pl];
      const u = unitById.get(pl.id)!;
      const f = placeTransform({ minX: u.minX ?? 0, minY: u.minY ?? 0, maxX: (u.minX ?? 0) + u.w, maxY: (u.minY ?? 0) + u.h }, pl);
      return ms.map((m) => {
        const odd = m.turn % 2 === 1;
        const w = odd ? m.item.h : m.item.w;
        const h = odd ? m.item.w : m.item.h;
        const a = f([m.x, m.y]);
        const b = f([m.x + w, m.y + h]);
        const turn = ((m.turn + turnOf(pl)) % 4) as Turn;
        const tw = turn % 2 ? m.item.h : m.item.w;
        const th = turn % 2 ? m.item.w : m.item.h;
        return { id: m.item.id, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: tw, h: th, rot: turn % 2 === 1, turn };
      });
    }),
  }));
  return { ...r, sheets, unplaced };
}

/**
 * Sheet area a nest uses: every sheet but the last in full, and the last up to its
 * highest part plus the gap. What a shop charges for, near enough, and what
 * "tighter" means here.
 */
export function nestSheetArea(r: NestResult): number {
  if (!r.sheets.length) return 0;
  const last = r.sheets[r.sheets.length - 1];
  const top = last.placements.reduce((a, pl) => Math.max(a, pl.y + pl.h), 0);
  const gap = r.spacing ?? 0;
  return (r.sheets.length - 1) * r.sheetW * r.sheetH + r.sheetW * Math.min(r.sheetH, top + gap);
}

/** True when a is a better nest than b: fewer parts left over, fewer sheets, less sheet area. */
export function betterNest(a: NestResult, b: NestResult): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
  return nestSheetArea(a) < nestSheetArea(b) - 1e-6;
}

/** Small seeded generator (mulberry32), so a budgeted nest can be repeated. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORDERS: ((a: NestItem, b: NestItem) => number)[] = [
  (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.area - a.area,
  (a, b) => b.area - a.area,
  (a, b) => b.w * b.h - a.w * a.h,
  (a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h) || b.area - a.area,
];

/**
 * Nest parts onto sheets. Parts with an outline nest by their real shape (any of four
 * quarter turns); the result is the best of the outline tries and the bounding-box
 * nester, so it is never worse than the bounding-box nest.
 */
export function nest(items: NestItem[], sheetW: number, sheetH: number, spacing: number, opts: NestOptions = {}): NestResult {
  const gap = Math.max(0, spacing);
  let best: NestResult = { ...nestBoxes(items, sheetW, sheetH, gap), method: 'box', spacing: gap };
  let tries = 1;
  if (!items.some((it) => it.outline?.length)) return { ...best, tries };
  // near-rectangular parts gain nothing from their outlines; skip the work unless given time
  const fill = items.reduce((a, it) => a + it.area, 0) / Math.max(1e-9, items.reduce((a, it) => a + it.w * it.h, 0));
  if (fill > RECT_FILL && !(opts.budgetMs || opts.maxTries)) return { ...best, tries };
  const r = NEST_COLUMN_MM;
  const prepared = new Map<string, Prepared>();
  const prep = (it: NestItem) => prepared.get(it.id) ?? prepared.set(it.id, prepare(it, gap, r)).get(it.id)!;
  const maxTries = opts.maxTries ?? Infinity;
  const pairings = new Map<string, Units>();
  const unitsFor = (window: number, minSave: number): Units => {
    const key = `${window}:${minSave}`;
    let u = pairings.get(key);
    if (!u) pairings.set(key, (u = window > 0 ? pairUp(items, prep, r, window, minSave) : { items, members: new Map() }));
    return u;
  };
  const consider = (units: Units, cmp: (a: NestItem, b: NestItem) => number, score: Score, shuffle?: () => number) => {
    const order = [...units.items].sort(cmp);
    if (shuffle) {
      // neighbours swapped at random and the odd part pulled forward
      const swaps = 1 + Math.floor(shuffle() * Math.max(1, order.length / 3));
      for (let i = 0; i < swaps; i++) {
        const a = Math.floor(shuffle() * order.length);
        const b = Math.min(order.length - 1, a + 1 + Math.floor(shuffle() * 3));
        [order[a], order[b]] = [order[b], order[a]];
      }
      if (shuffle() < 0.3 && order.length > 1) {
        const [it] = order.splice(Math.floor(shuffle() * order.length), 1);
        order.splice(Math.floor(shuffle() * order.length), 0, it);
      }
    }
    const res = { ...expandPairs(outlinePass(order.map(prep), sheetW, sheetH, gap, r, score), units), spacing: gap };
    tries++;
    if (betterNest(res, best)) best = res;
  };
  // the deterministic tries the app runs on every edit
  const quick: [number, number, number, Score][] = [
    [6, 0.08, 0, 'snug'],
    [6, 0.08, 1, 'low'],
    [0, 0, 0, 'snug'],
    [0, 0, 1, 'low'],
  ];
  for (const [window, minSave, order, score] of quick) {
    if (tries >= maxTries) break;
    consider(unitsFor(window, minSave), ORDERS[order], score);
  }
  const budget = opts.budgetMs ?? 0;
  if (budget > 0 || (opts.maxTries ?? 0) > tries) {
    const now = opts.now ?? (() => performance.now());
    const end = now() + budget;
    const rand = rng(opts.seed ?? 1);
    const windows = [0, 3, 6, 10];
    const saves = [0.03, 0.08, 0.15];
    while (tries < maxTries && (budget <= 0 || now() < end)) {
      const window = windows[Math.floor(rand() * windows.length)];
      const units = unitsFor(window, window ? saves[Math.floor(rand() * saves.length)] : 0);
      consider(units, ORDERS[Math.floor(rand() * ORDERS.length)], rand() < 0.6 ? 'snug' : 'low', rand);
    }
  }
  return { ...best, tries };
}

/** Nest each group onto its own sheets (one metal per sheet), numbered in group order. */
export function nestGroups(groups: { material: string; thickness?: number; items: NestItem[] }[], sheetW: number, sheetH: number, spacing: number, opts: NestOptions = {}): NestResult {
  if (groups.length <= 1) return nest(groups[0]?.items ?? [], sheetW, sheetH, spacing, opts);
  const sheets: NestSheet[] = [];
  const unplaced: string[] = [];
  for (const g of groups) {
    // the budget is shared out by part count
    const share = opts.budgetMs ? (opts.budgetMs * g.items.length) / Math.max(1, groups.reduce((a, x) => a + x.items.length, 0)) : 0;
    const r = nest(g.items, sheetW, sheetH, spacing, { ...opts, budgetMs: share });
    for (const s of r.sheets) sheets.push({ ...s, index: sheets.length, material: g.material, ...(g.thickness != null ? { thickness: g.thickness } : {}) });
    unplaced.push(...r.unplaced);
  }
  const used = sheets.reduce((a, s) => a + s.used, 0);
  return { sheets, unplaced, sheetW, sheetH, utilisation: sheets.length ? used / (sheets.length * sheetW * sheetH) : 0, spacing: Math.max(0, spacing) };
}

export interface NestGroup {
  material: string;
  /** Sheet thickness, when it isn't the plates' own. */
  thickness?: number;
  items: NestItem[];
}

/** A nest made elsewhere (the cloud's tight nest), kept in the project while the parts still match it. */
export interface SavedNest {
  kind: 'nest';
  /** `nestFingerprint` of the parts and sheet it was made for. */
  fingerprint: string;
  result: NestResult;
  /** 'tight' is the 90-second nest; 'default' the 30-second one. */
  budget: 'default' | 'tight';
  /** Sheet area of the local nest it replaced, for "n% less sheet" in the Cut sheets tab. */
  localArea?: number;
  localSheets?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Everything a nest depends on, as one string: part ids, metals, outlines (to 0.001 mm,
 * so the browser and the server agree), sheet size and gap. A saved nest only stands
 * while this is unchanged.
 */
export function nestFingerprint(groups: NestGroup[], sheetW: number, sheetH: number, spacing: number): string {
  return hashText(JSON.stringify({
    v: 1,
    sheet: [sheetW, sheetH, spacing],
    groups: groups.map((g) => ({
      m: g.material,
      t: g.thickness,
      items: g.items.map((it) => ({
        id: it.id,
        box: [r3(it.w), r3(it.h), r3(it.minX ?? 0), r3(it.minY ?? 0)],
        outline: (it.outline ?? []).map((ring) => ring.map(([x, y]) => [r3(x), r3(y)])),
      })),
    })),
  }));
}

/** Two FNV-1a passes with different seeds: 64 bits as 16 hex characters. Not for secrets. */
function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193 + 2);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Why a nest can't be used for these parts, or null when every part is placed exactly once at its size. */
export function nestMismatch(groups: NestGroup[], r: NestResult): string | null {
  const want = new Map<string, NestItem>();
  for (const g of groups) for (const it of g.items) want.set(it.id, it);
  const seen = new Set<string>();
  for (const s of r.sheets)
    for (const pl of s.placements) {
      const it = want.get(pl.id);
      if (!it) return `the nest has a part the design doesn't (${pl.id})`;
      if (seen.has(pl.id)) return `the nest places ${pl.id} twice`;
      seen.add(pl.id);
      const t = turnOf(pl);
      const w = t % 2 ? it.h : it.w;
      const h = t % 2 ? it.w : it.h;
      if (Math.abs(pl.w - w) > 0.01 || Math.abs(pl.h - h) > 0.01) return `${pl.id} is a different size in the nest`;
      if (pl.x < -1e-6 || pl.y < -1e-6 || pl.x + pl.w > r.sheetW + 1e-6 || pl.y + pl.h > r.sheetH + 1e-6) return `${pl.id} is off the sheet`;
    }
  const placed = seen.size + r.unplaced.length;
  if (placed !== want.size) return `the nest has ${placed} parts and the design has ${want.size}`;
  return null;
}

/** A saved nest read from a file, or undefined when it isn't one. */
export function cleanSavedNest(raw: unknown): SavedNest | undefined {
  const o = raw as Partial<SavedNest> | null;
  if (!o || typeof o !== 'object' || o.kind !== 'nest' || typeof o.fingerprint !== 'string') return undefined;
  const r = o.result as NestResult | undefined;
  if (!r || !Array.isArray(r.sheets) || !Array.isArray(r.unplaced) || !(r.sheetW > 0) || !(r.sheetH > 0)) return undefined;
  const okPl = (pl: Placement) =>
    pl && typeof pl.id === 'string' && [pl.x, pl.y, pl.w, pl.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && (pl.turn == null || [0, 1, 2, 3].includes(pl.turn));
  if (!r.sheets.every((s) => s && Array.isArray(s.placements) && s.placements.every(okPl))) return undefined;
  return { ...o, budget: o.budget === 'tight' ? 'tight' : 'default' } as SavedNest;
}
