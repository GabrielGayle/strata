// Measuring tape: closest points between points, edges and faces, and which
// feature a pick should snap to. Pure geometry on plain [x, y, z] tuples so it
// can be tested without a renderer; the 3D view supplies the edges and a projector.
import type { V3 } from './section';
import type { Vec2 } from './geom2d';

export type Seg = [V3, V3];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Nearest point to p on segment a–b, with its parameter along the segment (0 at a, 1 at b). */
export function closestOnSegment(p: V3, a: V3, b: V3): { point: V3; t: number; dist: number } {
  const d = sub(b, a);
  const L = dot(d, d);
  const t = L < 1e-18 ? 0 : clamp01(dot(sub(p, a), d) / L);
  const point = lerp(a, b, t);
  return { point, t, dist: dist3(p, point) };
}

/** Shortest distance between two segments: the closest pair of points (p on the first, q on the second). */
export function segmentSegment(a0: V3, a1: V3, b0: V3, b1: V3): { p: V3; q: V3; s: number; t: number; dist: number } {
  // Ericson, Real-Time Collision Detection 5.1.9
  const d1 = sub(a1, a0), d2 = sub(b1, b0), r = sub(a0, b0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      // parallel segments: any s works, start from a0 and let the clamps below sort it out
      s = den > EPS * a * e ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const p = add(a0, scale(d1, s));
  const q = add(b0, scale(d2, t));
  return { p, q, s, t, dist: dist3(p, q) };
}

/** Perpendicular foot of p on the (infinite) plane through q with normal n, and the signed distance along n. */
export function pointPlane(p: V3, q: V3, n: V3): { foot: V3; signed: number; dist: number } {
  const L = Math.hypot(n[0], n[1], n[2]) || 1;
  const u = scale(n, 1 / L);
  const signed = dot(sub(p, q), u);
  return { foot: sub(p, scale(u, signed)), signed, dist: Math.abs(signed) };
}

/** Angle between two lines (not directed), 0–90°. */
export function lineAngle(d1: V3, d2: V3): number {
  const l = Math.hypot(...d1) * Math.hypot(...d2);
  if (l < 1e-18) return 0;
  const c = Math.min(1, Math.abs(dot(d1, d2)) / l);
  return (Math.acos(c) * 180) / Math.PI;
}

// ---------- measurements ----------

export type MeasureKind = 'pp' | 'll' | 'pl' | 'pf';

export const MEASURE_KINDS: { id: MeasureKind; label: string; title: string }[] = [
  { id: 'pp', label: 'Point–point', title: 'Distance between two points (with X / Y / Z deltas)' },
  { id: 'll', label: 'Line–line', title: 'Shortest distance between two edges, and the angle between them' },
  { id: 'pl', label: 'Point–line', title: 'Perpendicular distance from a point to an edge' },
  { id: 'pf', label: 'Point–face', title: 'Perpendicular distance from a point to a face (e.g. the gap between two plates)' },
];

/** What each pick of a measurement wants: a point, an edge or a face. */
export const PICKS: Record<MeasureKind, ['point' | 'edge', 'point' | 'edge' | 'face']> = {
  pp: ['point', 'point'],
  ll: ['edge', 'edge'],
  pl: ['point', 'edge'],
  pf: ['point', 'face'],
};

export interface Measurement {
  id: number;
  kind: MeasureKind;
  /** The dimension line runs from a to b. */
  a: V3;
  b: V3;
  dist: number;
  /** b − a, for point-to-point. */
  delta?: V3;
  /** Between the two edges, for line-to-line. */
  angle?: number;
  /** Picked edges (and the face's foot square) to draw faintly alongside. */
  guides: Seg[];
}

export type MeasureResult = Omit<Measurement, 'id'>;

export function measurePoints(a: V3, b: V3): MeasureResult {
  return { kind: 'pp', a, b, dist: dist3(a, b), delta: sub(b, a), guides: [] };
}

export function measureLines(e1: Seg, e2: Seg): MeasureResult {
  const r = segmentSegment(e1[0], e1[1], e2[0], e2[1]);
  return { kind: 'll', a: r.p, b: r.q, dist: r.dist, angle: lineAngle(sub(e1[1], e1[0]), sub(e2[1], e2[0])), guides: [e1, e2] };
}

export function measurePointLine(p: V3, e: Seg): MeasureResult {
  const r = closestOnSegment(p, e[0], e[1]);
  return { kind: 'pl', a: p, b: r.point, dist: r.dist, guides: [e] };
}

export function measurePointFace(p: V3, q: V3, n: V3): MeasureResult {
  const r = pointPlane(p, q, n);
  return { kind: 'pf', a: p, b: r.foot, dist: r.dist, guides: [] };
}

// ---------- snapping ----------

export type SnapKind = 'vertex' | 'midpoint' | 'edge' | 'face' | 'free';

export interface Snap {
  kind: SnapKind;
  point: V3;
  /** The edge involved (for vertex / midpoint / edge snaps, and the nearest edge when snapping is off). */
  edge?: Seg;
  /** Face normal under the cursor. */
  normal: V3;
}

export interface SnapInput {
  /** Cursor, screen px. */
  cursor: Vec2;
  /** Surface point under the cursor and its face normal. */
  hit: V3;
  normal: V3;
  /** Feature edges near the hit. */
  edges: Seg[];
  /** World → screen px. */
  project: (p: V3) => Vec2;
}

export const SNAP_LABEL: Record<SnapKind, string> = { vertex: 'Vertex', midpoint: 'Edge midpoint', edge: 'Edge', face: 'Face', free: 'Free (no snap)' };

/**
 * Where a pick lands: the nearest vertex, then an edge midpoint, then the nearest point
 * on an edge, else the face itself. Distances are judged on screen so the feel
 * doesn't change with zoom. With snapping off the raw surface point is used, but
 * the nearest edge is still reported so edge picks keep working.
 */
export function chooseSnap(inp: SnapInput, opts: { snap?: boolean; vertexPx?: number; edgePx?: number; reachPx?: number } = {}): Snap {
  const { snap = true, vertexPx = 10, edgePx = 8, reachPx = 40 } = opts;
  const c = inp.cursor;
  const px = (q: Vec2) => Math.hypot(q[0] - c[0], q[1] - c[1]);
  let bestV: { d: number; p: V3; e: Seg } | null = null;
  let bestM: { d: number; p: V3; e: Seg } | null = null;
  let bestE: { d: number; p: V3; e: Seg } | null = null;
  for (const e of inp.edges) {
    const sa = inp.project(e[0]), sb = inp.project(e[1]);
    for (const [s, p] of [[sa, e[0]], [sb, e[1]]] as [Vec2, V3][]) {
      const d = px(s);
      if (!bestV || d < bestV.d) bestV = { d, p, e };
    }
    const sm: Vec2 = [(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2];
    const dm = px(sm);
    if (!bestM || dm < bestM.d) bestM = { d: dm, p: lerp(e[0], e[1], 0.5), e };
    // nearest point on the edge as seen on screen, carried back to the world segment
    const dx = sb[0] - sa[0], dy = sb[1] - sa[1];
    const L = dx * dx + dy * dy;
    const t = L < 1e-9 ? 0 : clamp01(((c[0] - sa[0]) * dx + (c[1] - sa[1]) * dy) / L);
    const de = px([sa[0] + dx * t, sa[1] + dy * t]);
    if (!bestE || de < bestE.d) bestE = { d: de, p: lerp(e[0], e[1], t), e };
  }
  const near = bestE && bestE.d <= reachPx ? bestE.e : undefined;
  if (!snap) return { kind: 'free', point: inp.hit, edge: near, normal: inp.normal };
  if (bestV && bestV.d <= vertexPx) return { kind: 'vertex', point: bestV.p, edge: bestE && bestE.d <= vertexPx ? bestE.e : bestV.e, normal: inp.normal };
  if (bestM && bestM.d <= vertexPx) return { kind: 'midpoint', point: bestM.p, edge: bestM.e, normal: inp.normal };
  if (bestE && bestE.d <= edgePx) return { kind: 'edge', point: bestE.p, edge: bestE.e, normal: inp.normal };
  return { kind: 'face', point: inp.hit, edge: near, normal: inp.normal };
}

// ---------- live clearances while moving a plate ----------

/**
 * Gap between a body (its corner points) and a plate slab of the given thickness centred
 * on a plane, measured along the plane normal. Negative = they overlap by that much.
 */
export function slabGap(points: V3[], origin: V3, normal: V3, thickness: number): number {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) {
    const d = pointPlane(p, origin, normal).signed;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  if (!points.length) return Infinity;
  return Math.max(lo - thickness / 2, -thickness / 2 - hi);
}
