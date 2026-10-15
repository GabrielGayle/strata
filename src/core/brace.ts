// Bracing: threaded rods run through every plate's embedded tab like rebar,
// with nuts locking the plates on them, and laser-cut spacers replace loose
// spacers. Cross pieces are combs cast in under the plates (permanent); the
// spacing template is a comb cut against the stack's top profile that sits
// over the plates while the concrete cures and lifts off afterwards.
import {
  BIG,
  circlePath,
  difference,
  offset,
  pointInShape,
  rect,
  shapeArea,
  union,
  unionShapes,
  type ExPoly,
  type Shape,
  type Vec2,
} from './geom2d';
import { sectionShape, type Plane, type V3 } from './section';
import { stackFrame } from './heightfield';
import { planClearance } from './base';
import type { IndexedMesh } from './forms';
import type { Values } from './params';

// --- metric hardware ---------------------------------------------------------

export interface Metric {
  d: number;
  /** ISO 273 medium clearance hole. */
  hole: number;
  /** ISO 4032 hex nut: across flats and height. */
  nutS: number;
  nutH: number;
  /** ISO 7089 washer: outside diameter and thickness. */
  washerD: number;
  washerH: number;
}

export const METRIC: Record<string, Metric> = {
  M3: { d: 3, hole: 3.4, nutS: 5.5, nutH: 2.4, washerD: 7, washerH: 0.5 },
  M4: { d: 4, hole: 4.5, nutS: 7, nutH: 3.2, washerD: 9, washerH: 0.8 },
  M5: { d: 5, hole: 5.5, nutS: 8, nutH: 4.7, washerD: 10, washerH: 1 },
  M6: { d: 6, hole: 6.6, nutS: 10, nutH: 5.2, washerD: 12, washerH: 1.6 },
  M8: { d: 8, hole: 9, nutS: 13, nutH: 6.8, washerD: 16, washerH: 1.6 },
  M10: { d: 10, hole: 11, nutS: 16, nutH: 8.4, washerD: 20, washerH: 2 },
  M12: { d: 12, hole: 13.5, nutS: 18, nutH: 10.8, washerD: 24, washerH: 2.5 },
};

export const DEFAULT_STOCK = '100, 150, 200, 250, 300, 400, 500, 1000';

export function parseStock(text: unknown): number[] {
  const out = String(text ?? '')
    .split(/[,;\s]+/)
    .map((s) => parseFloat(s))
    .filter((x) => Number.isFinite(x) && x > 0);
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface RodLength {
  length: number;
  /** Stock length the rod comes from. */
  stock: number;
  /** True when the rod has to be cut down from that stock. */
  cut: boolean;
  /** Set when no length satisfies both the plates and the concrete cover. */
  problem?: string;
}

/**
 * Snap a rod to a stock length: the shortest stock that spans the stack and its
 * nuts, as long as it still stays inside the concrete. Otherwise cut one down.
 */
export function snapRodLength(min: number, max: number, stock: number[]): RodLength {
  const list = stock.length ? stock : parseStock(DEFAULT_STOCK);
  const longest = list[list.length - 1];
  const fit = list.find((s) => s >= min - 1e-6 && s <= max + 1e-6);
  if (fit !== undefined) return { length: fit, stock: fit, cut: false };
  if (min > max + 1e-6) {
    const len = Math.ceil(min / 5) * 5;
    return { length: len, stock: list.find((s) => s >= len) ?? longest, cut: true, problem: `Rods need ${min.toFixed(0)} mm to carry their nuts but only ${Math.max(0, max).toFixed(0)} mm fits inside the concrete.` };
  }
  // the next stock up would poke out of the concrete: cut to the longest length that fits
  const len = Math.max(Math.ceil(min / 5) * 5, Math.floor(max / 5) * 5);
  const from = list.find((s) => s >= len);
  if (from === undefined) return { length: len, stock: longest, cut: true, problem: `Rods need ${len.toFixed(0)} mm, longer than the longest stock length (${longest} mm).` };
  return { length: len, stock: from, cut: true };
}

// --- shared types --------------------------------------------------------------

export interface BraceIssue {
  severity: 'error' | 'warn' | 'info';
  message: string;
  plateKey?: string;
  at?: Vec2;
}

export interface HardwareRow {
  item: string;
  spec: string;
  qty: number;
  note?: string;
  /** For pricing: what is bought, and for rod the metres of bar. */
  kind?: 'rod' | 'nut' | 'washer';
  metres?: number;
}

/** A plate the bracing works with: its key, plane, and current outline. */
export interface BracePlate {
  key: string;
  family: string;
  plane: Plane;
  shape: Shape;
}

interface Frame {
  /** Stack direction (plate normal) and the plates' u direction, in world x/z. */
  dir: [number, number];
  pu: [number, number];
  top: number;
}

function frame(v: Values, top: number): Frame {
  const f = stackFrame(v);
  // plate u = up × normal = (n.z, 0, -n.x)
  return { dir: [f.stack[0], f.stack[1]], pu: [f.stack[1], -f.stack[0]], top };
}

const hasStack = (v: Values) => v.sliceMode === 'parallel' || v.sliceMode === 'waffle';

/** Plate-u positions of the waffle cross plates (the rods and spacers must miss them). */
function crossPlateUs(defs: { family: string; plane: Plane }[], fr: Frame): number[] {
  return defs.filter((d) => d.family === 'X').map((d) => d.plane.origin[0] * fr.pu[0] + d.plane.origin[2] * fr.pu[1]);
}

/** Moves each position to the nearest spot at least `clear` from every blocked position, staying in [lo, hi]. */
export function avoid(us: number[], blocked: number[], clear: number, lo: number, hi: number): number[] {
  const ok = (u: number) => blocked.every((b) => Math.abs(u - b) >= clear);
  return us.map((u) => {
    if (ok(u)) return u;
    for (let d = 0.5; d < hi - lo; d += 0.5) {
      if (u + d <= hi && ok(u + d)) return u + d;
      if (u - d >= lo && ok(u - d)) return u - d;
    }
    return u;
  });
}

/** Evenly spread positions across [a, b]: k inner points (rods) or k centred cells (spacers). */
const spread = (a: number, b: number, k: number, cells: boolean) =>
  Array.from({ length: k }, (_, j) => a + ((cells ? j + 0.5 : j + 1) * (b - a)) / (cells ? k : k + 1));

/** Longest half-length a line through `c` along `d` can reach while keeping `cover` inside the base. */
function halfReach(v: Values, c: [number, number], d: [number, number], cover: number, sign: 1 | -1): number {
  if (!v.baseOn) return BIG;
  // plan coords are (x, -z)
  const at = (h: number) => planClearance(v, c[0] + sign * d[0] * h, -(c[1] + sign * d[1] * h), 0);
  if (at(0) < cover) return 0;
  let lo = 0, hi = Math.max(v.baseLength, v.baseWidth);
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (at(m) >= cover) lo = m;
    else hi = m;
  }
  return lo;
}

// --- threaded rods ---------------------------------------------------------------

export interface Fixing {
  kind: 'nut' | 'washer';
  /** Distance along the rod from its centre. */
  s: number;
}

export interface Rod {
  /** Plate-u position and plate-y (negative: below the concrete surface, positive: up in the exposed steel). */
  u: number;
  y: number;
  /** Cast into the concrete (false: runs through the steel above it). */
  embedded: boolean;
  /** World end points. */
  a: V3;
  b: V3;
  length: RodLength;
  minLength: number;
  maxLength: number;
  fixings: Fixing[];
}

export interface RodPlan {
  size: string;
  spec: Metric;
  hole: number;
  rods: Rod[];
  dir: V3;
  nuts: number;
  washers: number;
  issues: BraceIssue[];
}

/** Which plates get a nut on both faces. */
function lockedPlates(v: Values, n: number): boolean[] {
  const every = Math.max(1, Math.round(v.nutEvery ?? 1));
  return Array.from({ length: n }, (_, i) => {
    if (v.nutPattern === 'every') return true;
    if (v.nutPattern === 'nth') return i % every === 0 || i === n - 1;
    return false;
  });
}

/** "u, y; u, y" pairs: across the plate from its centre line, and height above the concrete. */
export function parsePoints(text: unknown): [number, number][] {
  return String(text ?? '')
    .split(/[;\n]+/)
    .map((pair) => pair.split(/[,\s]+/).filter(Boolean).map(Number))
    .filter((p) => p.length >= 2 && p.every((x) => Number.isFinite(x)))
    .map((p) => [p[0], p[1]] as [number, number]);
}

/** Rod positions on the plate (u, y), from the chosen layout. */
export function rodPositions(v: Values, ua: number, ub: number): [number, number][] {
  const k = Math.max(1, Math.round(v.rodCount));
  const y0 = -v.rodDepth;
  const us = spread(ua, ub, k, false);
  switch (v.rodLayout) {
    case 'stagger':
      return us.map((u, i) => [u, i % 2 ? y0 + v.rodStagger : y0]);
    case 'grid': {
      const rows = Math.max(1, Math.round(v.rodRows));
      return Array.from({ length: rows }, (_, r) => us.map((u) => [u, y0 + r * v.rodRowGap] as [number, number])).flat();
    }
    case 'custom': {
      const mid = (ua + ub) / 2;
      return parsePoints(v.rodPoints).map(([u, y]) => [mid + u, y]);
    }
    default:
      return us.map((u) => [u, y0]);
  }
}

export function planRods(v: Values, defs: { family: string; plane: Plane; u0: number; u1: number }[], top: number, embed: number): RodPlan | null {
  if (!v.rodsOn) return null;
  const spec = METRIC[String(v.rodSize)] ?? METRIC.M5;
  const issues: BraceIssue[] = [];
  const P = defs.filter((d) => d.family === 'P');
  if (!hasStack(v) || P.length < 2) return null;
  const fr = frame(v, top);
  const t = v.thickness;
  const n = P.length;
  const hole = spec.d + Math.max(0, v.rodClearance);
  const inset = Math.max(0, v.tabInset ?? 0);
  const ua = P[0].u0 + inset, ub = P[0].u1 - inset;
  const xs = crossPlateUs(defs, fr);
  let pts = rodPositions(v, ua, ub);
  if (v.rodLayout !== 'custom') {
    const us = avoid(pts.map((p) => p[0]), xs, t / 2 + hole / 2 + (v.slotClearance ?? 0) + 1, ua, ub);
    pts = pts.map((p, i) => [us[i], p[1]]);
  }
  if (!pts.length) {
    issues.push({ severity: 'warn', message: 'No rod positions: add points as "u, y; u, y" (mm across from the plate centre, mm above the concrete).' });
    return { size: String(v.rodSize), spec, hole, rods: [], dir: [fr.dir[0], 0, fr.dir[1]], nuts: 0, washers: 0, issues };
  }
  for (const [u] of pts)
    if (xs.some((x) => Math.abs(u - x) < t / 2 + hole / 2))
      issues.push({ severity: 'error', message: `A threaded rod runs into a waffle cross plate at ${u.toFixed(0)} mm: move or recount the rods.` });
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < hole + v.minFeature)
        issues.push({ severity: 'error', message: `Two rods are closer than ${(hole + v.minFeature).toFixed(1)} mm at (${pts[i][0].toFixed(0)}, ${pts[i][1].toFixed(0)}): their holes would merge.` });

  // the stack, as distances along the rod
  const ss = P.map((d) => d.plane.origin[0] * fr.dir[0] + d.plane.origin[2] * fr.dir[1]);
  const locked = lockedPlates(v, n);
  const stackNut = spec.washerH + spec.nutH;
  const centre = (ss[0] + ss[n - 1]) / 2;
  const lockFixings: Fixing[] = [];
  const lockFace = (s: number, side: 1 | -1) => {
    lockFixings.push({ kind: 'washer', s: s - centre + side * (t / 2 + spec.washerH / 2) });
    lockFixings.push({ kind: 'nut', s: s - centre + side * (t / 2 + spec.washerH + spec.nutH / 2) });
  };
  ss.forEach((s, i) => {
    if (locked[i]) {
      lockFace(s, -1);
      lockFace(s, 1);
    }
  });
  // the outer plates are always clamped from outside
  if (!locked[0]) lockFace(ss[0], -1);
  if (!locked[n - 1]) lockFace(ss[n - 1], 1);

  // nuts between neighbouring plates must fit in the gap
  const gap = v.pitch - t;
  let worst = 0;
  for (let i = 0; i + 1 < n; i++) worst = Math.max(worst, (locked[i] ? stackNut : 0) + (locked[i + 1] ? stackNut : 0));
  if (worst > gap - 0.5)
    issues.push({ severity: 'error', message: `Nuts and washers need ${worst.toFixed(1)} mm between plates but the gap is ${gap.toFixed(1)} mm: lock fewer plates or use a smaller rod.` });

  const reach = spec.d; // thread left proud of the last nut
  const cover = v.braceCover;
  const stock = parseStock(v.rodStock);
  const nutR = Math.max(spec.washerD, spec.nutS / Math.cos(Math.PI / 6)) / 2;
  const rods: Rod[] = [];
  for (const [u, y] of pts) {
    const embedded = y + hole / 2 < 0;
    if (!embedded && y - hole / 2 < 0)
      issues.push({ severity: 'warn', message: `The rod at (${u.toFixed(0)}, ${y.toFixed(0)}) straddles the concrete surface: set it fully in the concrete or fully in the steel.` });
    // anchor nuts at the tips only grip where the rod is cast in
    const tips = embedded && v.rodTipNuts;
    const minLength = ss[n - 1] - ss[0] + t + 2 * (stackNut + reach + (tips ? spec.nutH + reach : 0));
    const c: [number, number] = [u * fr.pu[0] + centre * fr.dir[0], u * fr.pu[1] + centre * fr.dir[1]];
    const keep = embedded ? cover : 0;
    const maxLength = 2 * Math.min(halfReach(v, c, fr.dir, keep, 1), halfReach(v, c, fr.dir, keep, -1));
    const length = snapRodLength(minLength, maxLength, stock);
    if (length.problem && !issues.some((i) => i.message === length.problem)) issues.push({ severity: 'error', message: length.problem });
    const half = length.length / 2;
    const fixings = [...lockFixings];
    if (tips) {
      const tipS = half - reach - spec.nutH / 2;
      fixings.push({ kind: 'nut', s: -tipS }, { kind: 'nut', s: tipS });
    }
    rods.push({ u, y, embedded, a: [c[0] - fr.dir[0] * half, top + y, c[1] - fr.dir[1] * half], b: [c[0] + fr.dir[0] * half, top + y, c[1] + fr.dir[1] * half], length, minLength, maxLength, fixings });
  }

  // concrete cover around the cast-in rods' nuts
  const cast = rods.filter((r) => r.embedded);
  if (cast.length) {
    const topMost = Math.max(...cast.map((r) => r.y));
    const lowest = Math.min(...cast.map((r) => r.y));
    if (-topMost - nutR < cover)
      issues.push({ severity: -topMost - nutR < 0 ? 'error' : 'warn', message: `A cast-in rod sits ${(-topMost).toFixed(0)} mm down, leaving ${(-topMost - nutR).toFixed(1)} mm of concrete over its nuts (want ${cover} mm). Set it deeper, or raise it into the steel.` });
    if (v.baseOn && v.baseHeight + lowest - nutR < cover)
      issues.push({ severity: v.baseHeight + lowest - nutR < 0 ? 'error' : 'warn', message: `Only ${(v.baseHeight + lowest - nutR).toFixed(1)} mm of concrete under the lowest rod (want ${cover} mm).` });
    if (embed > 0 && -lowest + hole / 2 + v.minFeature > embed)
      issues.push({ severity: 'error', message: `Rod holes Ø${hole.toFixed(1)} at ${(-lowest).toFixed(0)} mm down break out of the ${embed} mm embedded tab: raise the rods or embed the plates deeper.` });
  }
  if (hole < spec.d + 0.2) issues.push({ severity: 'warn', message: `Rod holes Ø${hole.toFixed(1)} leave almost no clearance on ${spec.d} mm rod; laser holes come out tight.` });

  return {
    size: String(v.rodSize),
    spec,
    hole,
    rods,
    dir: [fr.dir[0], 0, fr.dir[1]],
    nuts: rods.reduce((a, r) => a + r.fixings.filter((f) => f.kind === 'nut').length, 0),
    washers: rods.reduce((a, r) => a + r.fixings.filter((f) => f.kind === 'washer').length, 0),
    issues,
  };
}

/** Rod holes for one plate; `held[i]` says whether rod i passes through steel with a clean edge around it. */
export function rodHoles(plan: RodPlan, plate: { key: string; family: string; shape: Shape }, minFeature: number): { holes: Shape; held: boolean[]; issues: BraceIssue[] } {
  const issues: BraceIssue[] = [];
  if (plate.family !== 'P' || !plate.shape.length) return { holes: [], held: plan.rods.map(() => false), issues };
  const r = plan.hole / 2;
  const ring = (rr: number, u: number, y: number): Vec2[] => Array.from({ length: 12 }, (_, i) => [u + rr * Math.cos((i * Math.PI) / 6), y + rr * Math.sin((i * Math.PI) / 6)] as Vec2);
  const holes: ExPoly[] = [];
  const held = plan.rods.map((rod) => {
    const centre: Vec2 = [rod.u, rod.y];
    if (!pointInShape(centre, plate.shape)) return false;
    holes.push({ outer: circlePath(rod.u, rod.y, r), holes: [] });
    if (ring(r + minFeature, rod.u, rod.y).every((p) => pointInShape(p, plate.shape))) return true;
    issues.push({ severity: 'warn', plateKey: plate.key, at: centre, message: `Rod hole sits less than ${minFeature} mm from the plate edge.` });
    return false;
  });
  return { holes: holes.length ? union(holes.map((h) => h.outer)) : [], held, issues };
}

export function rodHardware(plan: RodPlan): HardwareRow[] {
  const rows: HardwareRow[] = [];
  const groups = new Map<string, Rod[]>();
  for (const r of plan.rods) {
    const k = `${r.length.length}|${r.length.cut}|${r.length.stock}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const rods of groups.values()) {
    const L = rods[0].length;
    const k = rods.length;
    if (L.cut) {
      const per = Math.max(1, Math.floor(L.stock / (L.length + 2)));
      const bars = Math.ceil(k / per);
      rows.push({ item: 'Threaded rod', spec: `${plan.size} × ${L.length} mm (cut)`, qty: k, note: `cut from ${bars} × ${L.stock} mm bar${bars > 1 ? 's' : ''}`, kind: 'rod', metres: (bars * L.stock) / 1000 });
    } else rows.push({ item: 'Threaded rod', spec: `${plan.size} × ${L.length} mm`, qty: k, note: 'stock length, DIN 976', kind: 'rod', metres: (k * L.length) / 1000 });
  }
  if (plan.nuts) rows.push({ item: 'Hex nut', spec: `${plan.size} ISO 4032`, qty: plan.nuts, kind: 'nut' });
  if (plan.washers) rows.push({ item: 'Washer', spec: `${plan.size} ISO 7089`, qty: plan.washers, kind: 'washer' });
  return rows;
}

// --- laser-cut spacers ---------------------------------------------------------

export interface SpacerPart {
  key: string;
  family: 'C' | 'T';
  index: number;
  count: number;
  plane: Plane;
  shape: Shape;
  /** Where the part number should go. */
  labelAt: Vec2;
  labelMax: number;
}

export interface SpacerResult {
  parts: SpacerPart[];
  /** Plates each spacer holds, by key. */
  holds: Record<string, string[]>;
  issues: BraceIssue[];
}

/** Lowest point of the outline above u (the bottom edge), or null if the vertical misses it. */
export function bottomAt(shape: Shape, u: number): number | null {
  let best = Infinity;
  for (const ex of shape) {
    for (const p of [ex.outer, ...ex.holes]) {
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[j], b = p[i];
        if (a[0] <= u !== b[0] <= u) {
          const y = a[1] + ((u - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
          if (y < best) best = y;
        }
      }
    }
  }
  return best === Infinity ? null : best;
}

function topAtAll(shape: Shape, u: number): number | null {
  let best = -Infinity;
  for (const ex of shape) {
    for (const p of [ex.outer, ...ex.holes]) {
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[j], b = p[i];
        if (a[0] <= u !== b[0] <= u) {
          const y = a[1] + ((u - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
          if (y > best) best = y;
        }
      }
    }
  }
  return best === -Infinity ? null : best;
}

/** Vertical plane through plan point c whose u axis runs along d (world x/z). */
function verticalPlane(c: [number, number], d: [number, number], top: number): Plane {
  // u = up × n must equal d, so n = (-d.z, 0, d.x)
  return { origin: [c[0], top, c[1]], normal: [-d[1], 0, d[0]], u: [d[0], 0, d[1]], v: [0, 1, 0] };
}

interface Crossing {
  key: string;
  s: number;
  /** Plate-u where the spacer line crosses the plate. */
  u: number;
  shape: Shape;
}

function crossings(plates: BracePlate[], c: [number, number], d: [number, number]): Crossing[] {
  const out: Crossing[] = [];
  for (const p of plates) {
    if (p.family !== 'P' || !p.shape.length) continue;
    const n: [number, number] = [p.plane.normal[0], p.plane.normal[2]];
    const dn = d[0] * n[0] + d[1] * n[1];
    if (Math.abs(dn) < 1e-6) continue;
    const o: [number, number] = [p.plane.origin[0], p.plane.origin[2]];
    const s = ((o[0] - c[0]) * n[0] + (o[1] - c[1]) * n[1]) / dn;
    const x: [number, number] = [c[0] + s * d[0] - o[0], c[1] + s * d[1] - o[1]];
    out.push({ key: p.key, s, u: x[0] * p.plane.u[0] + x[1] * p.plane.u[2], shape: p.shape });
  }
  return out.sort((a, b) => a.s - b.s);
}

/**
 * Notch for a rod crossing an angled cross piece, open at the top so the rod
 * drops in with the plates. The rod meets the comb at the comb's angle A to the
 * stack, so its footprint stretches by 1/sin A and slides t/tan A through the thickness.
 */
function rodSlot(s: number, y: number, hole: number, t: number, sinA: number): Shape {
  const sn = Math.max(0.05, Math.abs(sinA));
  const half = t / (2 * Math.tan(Math.asin(sn))) + (hole / 2) * (1 / sn - 1);
  return unionShapes(union([circlePath(s - half, y, hole / 2)]), union([circlePath(s + half, y, hole / 2)]), rect(s - half - hole / 2, y, s + half + hole / 2, BIG));
}

export function buildSpacers(
  v: Values,
  defs: { family: string; plane: Plane; u0: number; u1: number }[],
  plates: BracePlate[],
  rods: RodPlan | null,
  insert: IndexedMesh | null,
  top: number,
  embed: number,
  supportBand: [number, number] | null,
): SpacerResult | null {
  const mode = String(v.spacerMode ?? 'off');
  if (mode === 'off') return null;
  const issues: BraceIssue[] = [];
  if (!hasStack(v)) {
    issues.push({ severity: 'info', message: 'Laser-cut spacers need an upright parallel or waffle stack.' });
    return { parts: [], holds: {}, issues };
  }
  const P = defs.filter((d) => d.family === 'P');
  if (P.length < 2) return null;
  const fr = frame(v, top);
  const t = v.thickness;
  const clr = Math.max(0, v.spacerClearance);
  const cover = v.braceCover;
  const inset = Math.max(0, v.tabInset ?? 0);
  const ua = P[0].u0 + inset, ub = P[0].u1 - inset;
  const xs = crossPlateUs(defs, fr);
  const parts: SpacerPart[] = [];
  const holds: Record<string, string[]> = {};
  const plateKeys = plates.filter((p) => p.family === 'P' && p.shape.length).map((p) => p.key);
  const clipInsert = (shape: Shape, plane: Plane): Shape => {
    if (!insert || v.insShape === 'none') return shape;
    const sec = sectionShape(insert, plane);
    return sec.length ? difference(shape, offset(sec, (v.clearance ?? 1) + 2)) : shape;
  };
  const keepLargest = (shape: Shape, what: string, key: string): Shape => {
    const pieces = shape.filter((ex) => (ex.depth ?? 0) === 0 && shapeArea([ex]) > 1);
    if (pieces.length > 1) {
      issues.push({ severity: 'warn', plateKey: key, message: `${what} falls apart into ${pieces.length} pieces; keeping the largest. Move it or make it taller.` });
      pieces.sort((a, b) => shapeArea([b]) - shapeArea([a]));
    }
    return pieces.length ? [pieces[0]] : [];
  };

  // --- cross pieces: combs cast in under the plates -----------------------------
  if (mode === 'cross' || mode === 'both') {
    const m = Math.max(1, Math.round(v.crossPieces));
    const A = (Math.max(-60, Math.min(60, v.crossAngle ?? 0)) * Math.PI) / 180;
    const cosA = Math.cos(A), sinA = Math.sin(A);
    const d: [number, number] = [cosA * fr.dir[0] + sinA * fr.pu[0], cosA * fr.dir[1] + sinA * fr.pu[1]];
    const blocked = [...xs, ...(Math.abs(sinA) < 0.05 && rods ? rods.rods.map((r) => r.u) : [])];
    const clear = t / 2 + Math.max(t / 2, rods ? rods.hole / 2 : 0) + clr + 2;
    const cs = avoid(spread(ua, ub, m, true), blocked, clear, ua, ub);
    // a plate crossing at angle A covers t / cos A along the comb, plus the comb's own thickness × tan A
    const hw = (t / 2 + clr) / cosA + (t / 2) * Math.abs(sinA / cosA);
    const yT = Math.min(-embed + Math.max(1, v.crossEngage), -1);
    const yB = yT - Math.max(v.crossHeight, v.crossEngage + v.minFeature);
    if (embed <= 0) issues.push({ severity: 'warn', message: 'Cross pieces sit under the plates in the concrete: give the plates an embed depth.' });
    if (v.baseOn && v.baseHeight + yB < cover)
      issues.push({ severity: v.baseHeight + yB < 0 ? 'error' : 'warn', message: `Cross pieces reach ${(-yB).toFixed(0)} mm down, leaving ${(v.baseHeight + yB).toFixed(1)} mm of concrete under them (want ${cover} mm).` });
    if (v.crossHeight - v.crossEngage < v.minFeature * 2)
      issues.push({ severity: 'warn', message: `Cross piece spine is only ${(v.crossHeight - v.crossEngage).toFixed(1)} mm below the slots: make the cross pieces taller.` });
    if (supportBand) {
      const [b0, b1] = supportBand;
      if (b1 > yB && b0 < yT) issues.push({ severity: 'warn', message: 'Cross pieces run into the support ring band: change the ring depth or the cross piece height.' });
    }
    cs.forEach((cu, j) => {
      const c: [number, number] = [cu * fr.pu[0], cu * fr.pu[1]];
      const plane = verticalPlane(c, d, top);
      const key = `C${j}`;
      const cr = crossings(plates, c, d);
      if (!cr.length) return;
      const reachF = halfReach(v, c, d, cover, 1);
      const reachB = halfReach(v, c, d, cover, -1);
      const land = Math.max(10, (v.pitch - t) / 2);
      const s0 = Math.max(cr[0].s - hw - land, -reachB);
      const s1 = Math.min(cr[cr.length - 1].s + hw + land, reachF);
      let shape: Shape = rect(s0, yB, s1, yT);
      const slots: Shape[] = [];
      const held: string[] = [];
      for (const x of cr) {
        if (x.s - hw < s0 + 2 || x.s + hw > s1 - 2) continue;
        const w = (t / 2 + clr) * Math.abs(sinA / cosA) + 0.5;
        const bs = [x.u - w, x.u, x.u + w].map((u) => bottomAt(x.shape, u)).filter((b): b is number => b !== null);
        if (!bs.length) continue;
        const b = Math.min(...bs);
        if (b > yT - 1) continue; // plate doesn't reach down to the comb here
        slots.push(rect(x.s - hw, b, x.s + hw, BIG));
        held.push(x.key);
      }
      if (rods && Math.abs(sinA) >= 0.05) {
        for (const r of rods.rods) {
          if (r.y - rods.hole / 2 > yT || r.y + rods.hole / 2 < yB) continue;
          const s = (r.u - cu) / sinA;
          if (s < s0 || s > s1) continue;
          slots.push(rodSlot(s, r.y, rods.hole, t, sinA));
        }
      }
      if (slots.length) shape = difference(shape, slots.flat());
      shape = keepLargest(clipInsert(shape, plane), `Cross piece ${j + 1}`, key);
      if (!shape.length || !held.length) return;
      holds[key] = held;
      parts.push({ key, family: 'C', index: j, count: m, plane, shape, labelAt: [(s0 + s1) / 2, (yB + yT - v.crossEngage) / 2], labelMax: Math.max(2, (v.crossHeight - v.crossEngage) * 0.6) });
    });
  }

  // --- spacing template: a comb cut against the top profile, lifted off after the cure ---
  if (mode === 'template' || mode === 'both') {
    const m = Math.max(1, Math.round(v.templateCount));
    const d = fr.dir;
    // rods may run up through the exposed steel too, so the template keeps clear of every rod line
    const tClear = Math.max(t + clr + 2, rods ? t / 2 + rods.spec.washerD / 2 + clr + 1 : 0);
    const cs = avoid(spread(ua, ub, m, true), [...xs, ...(rods ? rods.rods.map((r) => r.u) : [])], tClear, ua, ub);
    const hw = t / 2 + clr;
    const lift = Math.max(0, v.templateLift);
    const engage = Math.max(1, v.templateEngage);
    cs.forEach((cu, j) => {
      const c: [number, number] = [cu * fr.pu[0], cu * fr.pu[1]];
      const plane = verticalPlane(c, d, top);
      const key = `T${j}`;
      const cr = crossings(plates, c, d)
        .map((x) => {
          // the plate's highest point within the template's thickness
          const hs = [x.u - t / 2, x.u, x.u + t / 2].map((u) => topAtAll(x.shape, u)).filter((h): h is number => h !== null);
          return { ...x, h: hs.length ? Math.max(...hs) : null };
        })
        .filter((x): x is Crossing & { h: number } => x.h !== null && x.h > lift + 1);
      if (cr.length < 2) {
        issues.push({ severity: 'warn', message: `Spacing template ${j + 1} misses the plates: they have no material above the concrete there.` });
        return;
      }
      const hMax = Math.max(...cr.map((x) => x.h));
      const yTop = hMax + clr + Math.max(v.minFeature * 2, v.templateSpine);
      const land = Math.max(10, (v.pitch - t) / 2);
      // teeth between neighbouring plates hang down `engage` below the lower of the two tops
      const teeth: Shape[] = [];
      const edges = [cr[0].s - hw - land, ...cr.slice(0, -1).map((x, i) => (x.s + cr[i + 1].s) / 2), cr[cr.length - 1].s + hw + land];
      for (let i = 0; i <= cr.length; i++) {
        const left = cr[i - 1]?.h ?? cr[i].h;
        const right = cr[i]?.h ?? cr[i - 1].h;
        const bottom = Math.max(lift, Math.min(left, right) - engage);
        const a = i === 0 ? edges[0] : cr[i - 1].s;
        const b = i === cr.length ? edges[edges.length - 1] : cr[i].s;
        teeth.push(rect(a, bottom, b, yTop));
      }
      let shape = unionShapes(...teeth);
      shape = difference(shape, cr.flatMap((x) => rect(x.s - hw, -BIG, x.s + hw, x.h + clr)));
      shape = keepLargest(clipInsert(shape, plane), `Spacing template ${j + 1}`, key);
      if (!shape.length) return;
      const held = cr.filter((x, i) => {
        const nb = [cr[i - 1]?.h, cr[i + 1]?.h].filter((h): h is number => h !== undefined);
        return nb.some((h) => Math.min(h, x.h) - Math.max(lift, Math.min(h, x.h) - engage) >= 3);
      });
      holds[key] = held.map((x) => x.key);
      const thin = cr.length - held.length;
      if (thin) issues.push({ severity: 'warn', plateKey: key, message: `Spacing template ${j + 1} only grips ${held.length} of ${cr.length} plates: they stand too close to the concrete there. Raise the plates or lower the lift.` });
      parts.push({ key, family: 'T', index: j, count: m, plane, shape, labelAt: [(edges[0] + edges[edges.length - 1]) / 2, yTop - Math.max(v.minFeature * 2, v.templateSpine) / 2], labelMax: Math.max(2, Math.max(v.minFeature * 2, v.templateSpine) * 0.6) });
    });
  }

  // plates no spacer holds
  const anyHeld = new Set(Object.values(holds).flat());
  const loose = plateKeys.filter((k) => !anyHeld.has(k));
  if (parts.length && loose.length)
    issues.push({ severity: 'warn', plateKey: loose[0], message: `${loose.length} plate(s) aren't held by any spacer: move the spacers or add more.` });
  return { parts, holds, issues };
}
