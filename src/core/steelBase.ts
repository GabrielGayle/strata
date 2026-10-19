// The steel base: a laser-cut base plate in place of the concrete. Every plate
// gets tabs along its bottom edge that drop through matching slots, so the
// plates stand square on their own; you weld them from underneath where the
// tabs come through (or twist the tabs), never reaching between plates.
import { basePlan, bottomSpans } from './base';
import { BIG, circlePath, difference, intersection, rect, shapeBBox, union, unionShapes, type Path, type Shape } from './geom2d';
import type { Values } from './params';
import type { Plane } from './section';

export interface SteelBaseSpec {
  /** Base plate thickness; the plates stand on its top face (world y = thickness). */
  thickness: number;
  fixing: 'weld' | 'twist';
  /** How far each tab reaches below the plate's bottom edge. */
  tabDepth: number;
  tabLength: number;
  pitch: number;
  clearance: number;
  edge: number;
  stagger: boolean;
  holes: number;
  holeDia: number;
}

export function steelBaseSpec(v: Values): SteelBaseSpec | null {
  if (!v.steelBaseOn) return null;
  const thickness = Math.max(0.5, Number(v.steelThickness) || 3);
  const fixing = v.steelFixing === 'twist' ? 'twist' : 'weld';
  const recess = Math.max(0, Math.min(Number(v.steelRecess) || 0, thickness - 0.5));
  return {
    thickness,
    fixing,
    tabDepth: fixing === 'twist' ? thickness + Math.max(1, Number(v.steelTwist) || 8) : thickness - recess,
    tabLength: Math.max(2, Number(v.steelTabLength) || 15),
    pitch: Math.max(5, Number(v.steelTabPitch) || 80),
    clearance: Math.max(0, Number(v.steelClearance) || 0),
    edge: Math.max(0, Number(v.steelEdge) || 0),
    stagger: v.steelStagger !== false,
    holes: Number(v.steelHoles) || 0,
    holeDia: Math.max(1, Number(v.steelHoleDia) || 6.5),
  };
}

/** Horizontal plane through the middle of the base plate; plan coords are (x, -z). */
export function steelPlane(s: SteelBaseSpec): Plane {
  return { origin: [0, s.thickness / 2, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] };
}

/** Where a vertical plate's line runs over a convex plan outline: [u0, u1] in the plate's own u, or null. */
export function planInterval(plane: Plane, poly: Path): [number, number] | null {
  const ox = plane.origin[0], oy = -plane.origin[2];
  const dx = plane.u[0], dy = -plane.u[2];
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const ex = x1 - x0, ey = y1 - y0;
    // inside of a CCW outline is to the left: cross(edge, p - p0) >= 0
    const c = ex * (oy - y0) - ey * (ox - x0);
    const d = ex * dy - ey * dx;
    if (Math.abs(d) < 1e-12) {
      if (c < 0) return null;
      continue;
    }
    const t = -c / d;
    if (d > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/** Cuts [a, b] intervals out of a list of spans. */
function subtractSpans(spans: [number, number][], cut: [number, number][]): [number, number][] {
  let out = spans;
  for (const [c0, c1] of cut) {
    const next: [number, number][] = [];
    for (const [a, b] of out) {
      if (c1 <= a || c0 >= b) next.push([a, b]);
      else {
        if (c0 > a) next.push([a, c0]);
        if (c1 < b) next.push([c1, b]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * Tab centres and lengths along one plate's usable bottom spans. Each span gets a
 * tab about every `pitch`; a plate gets at least two where it has room. With
 * `shift`, the tabs sit half way between where a neighbour's would be.
 */
export function tabLayout(spans: [number, number][], s: SteelBaseSpec, minLen: number, shift: boolean): { c: number; len: number }[] {
  const out: { c: number; len: number }[] = [];
  const total = spans.reduce((a, [x, y]) => a + Math.max(0, y - x), 0);
  for (const [a, b] of spans) {
    const L = b - a;
    if (L < minLen) continue;
    const len = Math.min(s.tabLength, L);
    let n = 1 + Math.floor((L - len) / s.pitch);
    // one long span alone: two tabs, one near each end, when they fit with a tab's gap between
    if (n === 1 && spans.length === 1 && L >= 3 * len && total === L) n = 2;
    if (n === 1) {
      out.push({ c: (a + b) / 2, len });
      continue;
    }
    const step = (L - len) / (n - 1);
    const cs = Array.from({ length: n }, (_, i) => a + len / 2 + i * step);
    if (shift && n >= 3) for (let i = 0; i + 1 < n; i++) out.push({ c: (cs[i] + cs[i + 1]) / 2, len });
    else for (const c of cs) out.push({ c, len });
  }
  return thin(out.sort((p, q) => p.c - q.c), s.pitch);
}

/**
 * Many short spans (a cross plate between crossings) each offer a tab; keep about one per
 * pitch, always both ends of the plate.
 */
function thin(tabs: { c: number; len: number }[], pitch: number): { c: number; len: number }[] {
  if (tabs.length <= 2) return tabs;
  const first = tabs[0], last = tabs[tabs.length - 1];
  if (last.c - first.c < pitch * 1.5) return [first, last];
  const keep = [first];
  let at = first.c;
  for (const t of tabs.slice(1, -1)) {
    if (t.c - at >= pitch * 0.75 && t.c - keep[keep.length - 1].c >= pitch * 0.5 && last.c - t.c >= pitch * 0.5) {
      keep.push(t);
      at = t.c;
    }
  }
  keep.push(last);
  return keep;
}

/**
 * Adds weld tabs to one upright plate's outline. `avoid` are u-intervals kept clear
 * (waffle crossings); `free` is the outline with anything that will be cut out of
 * the bottom edge already removed, so tabs land on steel that stays.
 */
export function addWeldTabs(outline: Shape, free: Shape, plane: Plane, s: SteelBaseSpec, v: Values, opts: { avoid: [number, number][]; shift: boolean }): { outline: Shape; tabs: { c: number; len: number }[] } {
  if (!outline.length) return { outline, tabs: [] };
  const over = planInterval(plane, basePlan(v, s.edge));
  if (!over) return { outline, tabs: [] };
  const end = Math.max(2, v.thickness);
  const minLen = Math.max(4, 2 * v.thickness);
  let spans = bottomSpans(free, 0)
    .map(([a, b]) => [Math.max(a, over[0]) + end, Math.min(b, over[1]) - end] as [number, number])
    .filter(([a, b]) => b - a >= minLen);
  spans = subtractSpans(spans, opts.avoid).filter(([a, b]) => b - a >= minLen);
  const tabs = tabLayout(spans, s, minLen, opts.shift);
  if (!tabs.length) return { outline, tabs };
  const shape = unionShapes(outline, ...tabs.map((t) => rect(t.c - t.len / 2, -s.tabDepth, t.c + t.len / 2, 0.15)));
  return { outline: shape, tabs };
}

export interface WeldTab {
  /** Part the tab belongs to, and its plate. */
  partId: string;
  plateKey: string;
  /** Tab span along the plate (its own u) and how far down it reaches. */
  u0: number;
  u1: number;
  /** Middle of the slot in plan (x, -z) and the slot's direction. */
  at: [number, number];
  dir: [number, number];
  length: number;
  /** Weld (or twist) order, from 1, and which pass: 1 tacks every plate at its ends, 2 fills the rest. */
  order: number;
  pass: 1 | 2;
}

/** The parts that stand on the base and drop tabs into it. */
type Standing = { id: string; plateKey: string; plane: Plane; shape: Shape; thickness: number };

/** Every tab that reaches into the base plate, read off the finished parts so slots follow moves and cut-outs. */
export function tabsOf(parts: Standing[]): Omit<WeldTab, 'order' | 'pass'>[] {
  const out: Omit<WeldTab, 'order' | 'pass'>[] = [];
  for (const p of parts) {
    if (Math.abs(p.plane.normal[1]) > 0.5 || Math.abs(p.plane.v[1]) < 0.99) continue;
    const band = intersection(p.shape, rect(-BIG, -BIG, BIG, -0.05));
    for (const ex of band) {
      const bb = shapeBBox([ex]);
      const mid = (bb.minX + bb.maxX) / 2;
      const ox = p.plane.origin[0] + p.plane.u[0] * mid, oz = p.plane.origin[2] + p.plane.u[2] * mid;
      out.push({ partId: p.id, plateKey: p.plateKey, u0: bb.minX, u1: bb.maxX, at: [ox, -oz], dir: [p.plane.u[0], -p.plane.u[2]], length: bb.maxX - bb.minX });
    }
  }
  return out;
}

/**
 * Weld order that keeps the heat moving about. Plates go from the middle of the base
 * outwards, alternating sides. The first round welds one end tab of every plate, the
 * second the other end, then the tabs between, a tab per plate per round.
 */
export function weldOrder(tabs: Omit<WeldTab, 'order' | 'pass'>[]): { tabs: WeldTab[]; plates: string[] } {
  const byPlate = new Map<string, Omit<WeldTab, 'order' | 'pass'>[]>();
  for (const t of tabs) byPlate.set(t.plateKey, [...(byPlate.get(t.plateKey) ?? []), t]);
  const plates = [...byPlate.entries()].map(([key, ts]) => ({
    key,
    ts: [...ts].sort((a, b) => a.u0 - b.u0),
    x: ts.reduce((a, t) => a + t.at[0], 0) / ts.length,
    y: ts.reduce((a, t) => a + t.at[1], 0) / ts.length,
  }));
  // centre out along the longer way the plates are spread, alternating sides
  const spread = (k: 'x' | 'y') => (plates.length ? Math.max(...plates.map((p) => p[k])) - Math.min(...plates.map((p) => p[k])) : 0);
  const k = spread('x') >= spread('y') ? 'x' : 'y';
  const mid = plates.length ? plates.reduce((a, p) => a + p[k], 0) / plates.length : 0;
  const lo = plates.filter((p) => p[k] < mid - 1e-6).sort((a, b) => b[k] - a[k]);
  const hi = plates.filter((p) => p[k] >= mid - 1e-6).sort((a, b) => a[k] - b[k]);
  const order: typeof plates = [];
  for (let i = 0; i < Math.max(lo.length, hi.length); i++) {
    if (hi[i]) order.push(hi[i]);
    if (lo[i]) order.push(lo[i]);
  }
  // within a plate: first end, last end, then inwards from alternate ends
  const seq = (n: number) => {
    const out: number[] = [];
    for (let i = 0, j = n - 1; i <= j; i++, j--) {
      out.push(i);
      if (j !== i) out.push(j);
    }
    return out;
  };
  const queues = order.map((p) => seq(p.ts.length).map((i) => p.ts[i]));
  const out: WeldTab[] = [];
  let n = 1;
  for (let round = 0; queues.some((q) => q.length > round); round++)
    for (const q of queues) if (q[round]) out.push({ ...q[round], order: n++, pass: round < 2 ? 1 : 2 });
  return { tabs: out, plates: order.map((p) => p.key) };
}

/** The base plate in plan (x, -z): the base outline with a slot for every tab and any fixing holes. */
export function steelBaseShape(v: Values, s: SteelBaseSpec, tabs: WeldTab[], thicknessOf: (plateKey: string) => number): Shape {
  const outline = union([basePlan(v)]);
  const c = s.clearance;
  const slots: Path[] = tabs.map((t) => {
    const hw = thicknessOf(t.plateKey) / 2 + c;
    const [dx, dy] = t.dir;
    const nx = -dy, ny = dx;
    const h = t.length / 2 + c;
    const [x, y] = t.at;
    return [
      [x - dx * h - nx * hw, y - dy * h - ny * hw],
      [x + dx * h - nx * hw, y + dy * h - ny * hw],
      [x + dx * h + nx * hw, y + dy * h + ny * hw],
      [x - dx * h + nx * hw, y - dy * h + ny * hw],
    ];
  });
  const holes = fixingHoles(v, s).map(([x, y]) => circlePath(x, y, s.holeDia / 2));
  const cut = [...slots, ...holes];
  return cut.length ? difference(outline, union(cut)) : outline;
}

/** Centres of the fixing holes, in from each corner. */
export function fixingHoles(v: Values, s: SteelBaseSpec): [number, number][] {
  if (s.holes < 4) return [];
  const corner = Math.max(0, Number(v.baseCornerChamfer) || 0);
  const inset = Math.max(s.edge, s.holeDia) + s.holeDia / 2 + corner / 2;
  const a = v.baseLength / 2 - inset, b = v.baseWidth / 2 - inset;
  if (a <= 0 || b <= 0) return [];
  return [[-a, -b], [a, -b], [a, b], [-a, b]];
}
