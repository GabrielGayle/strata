// The concrete base footprint (with chamfered corners and top edge) and the
// embedded support ring: a horizontal plate cut from the same sheet, cast into
// the concrete, with mortises that every plate's tenons drop through so the
// whole stack holds its spacing and angle while it cures and afterwards.
import * as THREE from 'three';
import { BIG, circlePath, difference, intersection, offset, rect, shapeArea, shapeBBox, signedArea, simplifyShape, union, unionShapes, type Path, type Shape } from './geom2d';
import type { Values } from './params';
import type { Plane } from './section';

const SQ2 = Math.SQRT2;

/** Corner chamfer leg and top-edge chamfer, clamped so the base stays a solid block. */
export function baseChamfers(v: Values): { corner: number; edge: number } {
  const half = Math.min(v.baseLength, v.baseWidth) / 2;
  const edge = Math.max(0, Math.min(v.baseEdgeChamfer ?? 0, v.baseHeight - 1, half - 1));
  const corner = Math.max(0, Math.min(v.baseCornerChamfer ?? 0, half - edge - 1));
  return { corner, edge };
}

/**
 * Plan outline of the base (x, -z), offset inwards by `inset` (negative grows it).
 * Always 8 points, counter-clockwise; square corners stay square when grown.
 */
export function basePlan(v: Values, inset = 0): Path {
  const { corner } = baseChamfers(v);
  const a = v.baseLength / 2 - inset;
  const b = v.baseWidth / 2 - inset;
  // offsetting a 45° chamfer line by d moves its legs by d(2 - √2)
  const k = corner > 0 ? Math.max(0, Math.min(corner - inset * (2 - SQ2), Math.min(a, b))) : 0;
  return [
    [-a + k, -b],
    [a - k, -b],
    [a, -b + k],
    [a, b - k],
    [a - k, b],
    [-a + k, b],
    [-a, b - k],
    [-a, -b + k],
  ];
}

/** Is a plan point inside the (convex) base outline at this inset? Returns the clearance in mm (negative = outside). */
export function planClearance(v: Values, x: number, y: number, inset = 0): number {
  const p = basePlan(v, inset);
  let m = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // CCW outline: inside is to the left of each edge
    m = Math.min(m, (dx * (y - y0) - dy * (x - x0)) / len);
  }
  return m;
}

function pathArea(p: Path): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** Plan inset of the base side at height y (the top-edge chamfer pulls it in near the top). */
export function insetAt(v: Values, y: number): number {
  const { edge } = baseChamfers(v);
  return edge > 0 ? Math.max(0, y - (v.baseHeight - edge)) : 0;
}

/** Concrete volume of the base between two heights (mm³), chamfers included. */
export function baseVolumeBetween(v: Values, y0: number, y1: number, outline?: Shape | null): number {
  const lo = Math.max(0, Math.min(y0, y1));
  const hi = Math.min(v.baseHeight, Math.max(y0, y1));
  if (hi <= lo) return 0;
  // area is quadratic in y on each side of the chamfer start, so Simpson is exact per piece
  const { edge } = baseChamfers(v);
  const cuts = [lo, ...[v.baseHeight - edge].filter((c) => c > lo && c < hi), hi];
  let vol = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    const A = (y: number) => (outline?.length ? shapeArea(baseRegion(v, outline, insetAt(v, y))) : pathArea(basePlan(v, insetAt(v, y))));
    vol += ((b - a) / 6) * (A(a) + 4 * A((a + b) / 2) + A(b));
  }
  return vol;
}

/** Move every point of a closed ring inwards by d along its corner bisector (keeps the point count, for meshing a chamfer). */
export function insetRing(p: Path, d: number): Path {
  const ccw = signedArea(p) > 0 ? 1 : -1;
  return p.map((q, i) => {
    const a = p[(i + p.length - 1) % p.length], b = p[(i + 1) % p.length];
    const e0 = [q[0] - a[0], q[1] - a[1]], e1 = [b[0] - q[0], b[1] - q[1]];
    const l0 = Math.hypot(e0[0], e0[1]) || 1, l1 = Math.hypot(e1[0], e1[1]) || 1;
    // inward normals of the two edges (left of travel on a CCW ring)
    const n0 = [(-e0[1] / l0) * ccw, (e0[0] / l0) * ccw], n1 = [(-e1[1] / l1) * ccw, (e1[0] / l1) * ccw];
    const bx = n0[0] + n1[0], by = n0[1] + n1[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) return [q[0] + n0[0] * d, q[1] + n0[1] * d] as [number, number];
    const k = Math.min(3, 1 / Math.max(1e-3, (bx * n0[0] + by * n0[1]) / bl));
    return [q[0] + (bx / bl) * d * k, q[1] + (by / bl) * d * k] as [number, number];
  });
}

/** Closed mesh of a base cut round the plates: its outline (holes too) straight up, with the top edge chamfer. */
function outlineGeometry(v: Values, outline: Shape): THREE.BufferGeometry {
  const H = v.baseHeight;
  const { edge } = baseChamfers(v);
  const pos: number[] = [];
  const w = (q: [number, number], y: number) => [q[0], y, -q[1]];
  for (const ex of outline) {
    // outer ring CCW, holes CW, so every wall faces out of the concrete
    const outer = signedArea(ex.outer) > 0 ? ex.outer : [...ex.outer].reverse();
    const holes = ex.holes.map((h) => (signedArea(h) < 0 ? h : [...h].reverse()));
    for (const ring of [outer, ...holes]) {
      const levels: { y: number; p: Path }[] = [{ y: 0, p: ring }];
      if (edge > 0) levels.push({ y: H - edge, p: ring }, { y: H, p: insetRing(ring, edge) });
      else levels.push({ y: H, p: ring });
      for (let r = 0; r + 1 < levels.length; r++) {
        const lo = levels[r], hi = levels[r + 1];
        for (let i = 0; i < ring.length; i++) {
          const j = (i + 1) % ring.length;
          const a = w(lo.p[i], lo.y), b = w(lo.p[j], lo.y), c = w(hi.p[j], hi.y), d = w(hi.p[i], hi.y);
          // plan (x, y) maps to world (x, -z), so a CCW plan ring seen from outside goes a, b, c
          pos.push(...a, ...b, ...c, ...a, ...c, ...d);
        }
      }
    }
    // top and bottom caps
    const top = edge > 0 ? { o: insetRing(outer, edge), h: holes.map((h) => insetRing(h, edge)) } : { o: outer, h: holes };
    for (const [cap, y, up] of [[{ o: outer, h: holes }, 0, false], [top, H, true]] as const) {
      const contour = cap.o.map(([x, z]) => new THREE.Vector2(x, z));
      const hs = cap.h.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
      const flat = [cap.o, ...cap.h].flat() as [number, number][];
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, hs)) {
        const [a, b, c] = [flat[i], flat[j], flat[k]].map((q) => w(q, y));
        if (up) pos.push(...a, ...b, ...c);
        else pos.push(...a, ...c, ...b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Closed mesh of the chamfered base, sitting on y = 0 (cut round the plates when it has an outline). */
export function baseGeometry(v: Values, outline?: Shape | null): THREE.BufferGeometry {
  if (outline?.length) return outlineGeometry(v, outline);
  const H = v.baseHeight;
  const { edge } = baseChamfers(v);
  const rings: { y: number; p: Path }[] = [{ y: 0, p: basePlan(v, 0) }];
  if (edge > 0) rings.push({ y: H - edge, p: basePlan(v, 0) }, { y: H, p: basePlan(v, edge) });
  else rings.push({ y: H, p: basePlan(v, 0) });
  const pos: number[] = [];
  const centre = new THREE.Vector3(0, H / 2, 0);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  const tri = (a: number[], b: number[], c: number[]) => {
    A.fromArray(a);
    B.fromArray(b);
    C.fromArray(c);
    n.subVectors(B, A).cross(m.subVectors(C, A));
    if (n.lengthSq() < 1e-12) return;
    // convex body: make every face point away from the centre
    m.copy(A).add(B).add(C).divideScalar(3).sub(centre);
    if (n.dot(m) < 0) pos.push(...a, ...c, ...b);
    else pos.push(...a, ...b, ...c);
  };
  const w = (q: [number, number], y: number) => [q[0], y, -q[1]];
  for (let r = 0; r + 1 < rings.length; r++) {
    const lo = rings[r], hi = rings[r + 1];
    for (let i = 0; i < lo.p.length; i++) {
      const j = (i + 1) % lo.p.length;
      const a = w(lo.p[i], lo.y), b = w(lo.p[j], lo.y), c = w(hi.p[j], hi.y), d = w(hi.p[i], hi.y);
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  for (const ring of [rings[0], rings[rings.length - 1]]) {
    const p = ring.p.map((q) => w(q, ring.y));
    for (let i = 1; i + 1 < p.length; i++) tri(p[0], p[i], p[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// --- a base that follows the plates ---------------------------------------------

/** Base › Outline settings, shared by the concrete and the steel base. */
export interface OutlineSpec {
  /** The Length × Width rectangle, or cut round the plates' feet. */
  shape: 'rect' | 'follow' | 'wrap';
  /** Base kept beyond every plate's foot (mm). */
  margin: number;
  /** Follow: gaps between feet narrower than this are filled (mm). */
  bridge: number;
  /** Follow: fill openings the plates enclose (the middle of a ring). */
  fillMiddle: boolean;
  /** Corner rounding radius (mm) and the profile the outline is grown with. */
  round: number;
  profile: 'round' | 'miter' | 'square';
}

export function outlineSpec(v: Values): OutlineSpec {
  return {
    shape: v.baseOutline === 'follow' || v.baseOutline === 'wrap' ? v.baseOutline : 'rect',
    margin: Math.max(0, Number(v.baseReach) || 0),
    bridge: Math.max(0, Number(v.baseBridge) || 0),
    fillMiddle: v.baseFillMiddle !== false,
    round: Math.max(0, Number(v.baseRound) || 0),
    profile: v.baseProfile === 'straight' ? 'miter' : v.baseProfile === 'bevel' ? 'square' : 'round',
  };
}

type Standing = { plane: Plane; shape: Shape; thickness: number };

/** Each upright plate's foot in plan (x, -z): where it meets and goes into the base, as wide as the plate is thick. */
export function plateFeet(parts: Standing[]): Path[] {
  const out: Path[] = [];
  for (const p of parts) {
    if (Math.abs(p.plane.normal[1]) > 0.5 || Math.abs(p.plane.v[1]) < 0.99) continue;
    const ux = p.plane.u[0], uy = -p.plane.u[2];
    const nx = -uy * (p.thickness / 2), ny = ux * (p.thickness / 2);
    // everything at or below the top of the base: the edge it stands on, and tabs or embedded steel under it
    for (const ex of intersection(p.shape, rect(-BIG, -BIG, BIG, 1))) {
      const bb = shapeBBox([ex]);
      const at = (u: number): [number, number] => [p.plane.origin[0] + ux * u, -p.plane.origin[2] + uy * u];
      const [a, b] = [at(bb.minX), at(bb.maxX)];
      const q: Path = [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
      out.push(signedArea(q) < 0 ? q.reverse() : q);
    }
  }
  return out;
}

function hull(pts: [number, number][]): Path {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const h: [number, number][] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    return h.slice(0, -1);
  };
  return [...half(p), ...half([...p].reverse())];
}

// 0.1 mm arcs: inside a laser's kerf or a router's, and quick to grow round many plates
const ARC = 0.1;

/**
 * A base outline cut round the plates' feet (plan x, -z). Follow: every foot grown by the
 * margin, gaps up to `bridge` filled, the middle filled, corners rounded. Wrap: one convex
 * outline round all the feet. `keep` mm always stays round every foot.
 */
export function followOutline(feet: Path[], o: OutlineSpec, keep: number, minFeature: number): Shape {
  const foot = union(feet);
  const grow = (sh: Shape, d: number, jt: OutlineSpec['profile'] = o.profile) => offset(sh, d, jt, ARC);
  let shape: Shape;
  if (o.shape === 'wrap') shape = grow(union([hull(foot.flatMap((e) => e.outer))]), o.margin);
  else {
    shape = grow(grow(foot, o.margin + o.bridge / 2), -o.bridge / 2);
    if (o.fillMiddle) shape = shape.map((e) => ({ outer: e.outer, holes: [] }));
  }
  if (o.round > 0) {
    // round the outside corners, then the inside ones
    shape = grow(grow(shape, -o.round, 'round'), o.round, 'round');
    shape = grow(grow(shape, o.round, 'round'), -o.round, 'round');
  }
  shape = unionShapes(shape, grow(foot, keep, 'round'));
  // growing out and back can leave hairline spikes where two curves meet; shave off anything thinner than twice the least feature
  const d = Math.max(0.5, minFeature);
  shape = grow(grow(shape, -d, 'round'), d, 'round');
  // a smooth outline needs few points: keeps the cut files small and the checks quick
  return simplifyShape(shape, 0.05);
}

/** The concrete base in plan at an inset: the chamfered rectangle, or its outline cut round the plates. */
export function baseRegion(v: Values, outline: Shape | null | undefined, inset = 0): Shape {
  if (!outline?.length) return union([basePlan(v, inset)]);
  return inset ? offset(outline, -inset, 'round', ARC) : outline;
}

/** The largest outer ring of the base in plan, for drawings. */
export function baseRing(v: Values, outline: Shape | null | undefined, inset = 0): Path {
  const r = baseRegion(v, outline, inset);
  if (!outline?.length) return basePlan(v, inset);
  return r.reduce((best, e) => (Math.abs(signedArea(e.outer)) > Math.abs(signedArea(best)) ? e.outer : best), r[0]?.outer ?? []);
}

// --- embedded support ring ---------------------------------------------------

export interface SupportSpec {
  /** Depth of the ring's top face below the top of the concrete. */
  depth: number;
  thickness: number;
  inner: number;
  outer: number;
  /** World y of the ring's top and bottom faces. */
  yTop: number;
  yBottom: number;
  /** Plate-coordinate y the tenons reach down to (ring bottom minus the tail). */
  tenonBottom: number;
}

export function supportSpec(v: Values, top: number): SupportSpec | null {
  if (!v.baseOn || v.supportMode === 'off' || !v.supportMode) return null;
  const outer = v.supportOuter;
  const inner = Math.min(v.supportInner, outer - 2);
  if (outer <= 2) return null;
  const depth = v.supportDepth;
  const thickness = v.supportThickness;
  return { depth, thickness, inner: Math.max(0, inner), outer, yTop: top - depth, yBottom: top - depth - thickness, tenonBottom: -(depth + thickness + v.supportTail) };
}

/** Horizontal plane through the middle of the ring; plan coords are (x, -z). */
export function supportPlane(s: SupportSpec): Plane {
  return { origin: [0, (s.yTop + s.yBottom) / 2, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] };
}

/** u-intervals along a plate's line (in its own coords) that lie on the ring band, ends pulled in by `land`. */
export function ringIntervals(plane: Plane, s: SupportSpec, land: number): [number, number][] {
  // plan line: P(u) = O + u D, with D a unit vector
  const ox = plane.origin[0], oy = -plane.origin[2];
  const dx = plane.u[0], dy = -plane.u[2];
  const b = ox * dx + oy * dy;
  const c0 = ox * ox + oy * oy;
  const span = (r: number): [number, number] | null => {
    const disc = b * b - (c0 - r * r);
    if (disc <= 0) return null;
    const q = Math.sqrt(disc);
    return [-b - q, -b + q];
  };
  const out = span(s.outer);
  if (!out) return [];
  const inn = s.inner > 0 ? span(s.inner) : null;
  const raw: [number, number][] = inn ? [[out[0], inn[0]], [inn[1], out[1]]] : [out];
  return raw.map(([a, z]) => [a + land, z - land] as [number, number]).filter(([a, z]) => z - a > 0);
}

/** Bottom edge of a plate (its u-extents just above its lowest retained line). */
export function bottomSpans(outline: Shape, bottom: number): [number, number][] {
  const band = intersection(outline, rect(-BIG, bottom + 0.2, BIG, bottom + 1));
  return band.map((ex) => {
    const bb = shapeBBox([ex]);
    return [bb.minX, bb.maxX] as [number, number];
  });
}

/**
 * Adds tenons to one plate outline. The plate is trimmed at the ring's top face
 * when the ring sits higher than the embedded tab, and each tenon drops from
 * the tab through the ring. Returns the new outline and the tenon spans.
 */
export function addTenons(outline: Shape, plane: Plane, s: SupportSpec, v: Values, embed: number): { outline: Shape; spans: [number, number][] } {
  if (!outline.length) return { outline, spans: [] };
  const bottom = -Math.min(embed, s.depth);
  let shape = s.depth < embed ? difference(outline, rect(-BIG, -BIG, BIG, -s.depth)) : outline;
  const tab = bottomSpans(shape, bottom);
  const minLen = Math.max(4, 2 * v.thickness);
  const spans: [number, number][] = [];
  for (const [a, z] of ringIntervals(plane, s, v.supportLand)) {
    for (const [t0, t1] of tab) {
      const lo = Math.max(a, t0), hi = Math.min(z, t1);
      if (hi - lo >= minLen) spans.push([lo, hi]);
    }
  }
  if (spans.length) shape = unionShapes(shape, ...spans.map(([lo, hi]) => rect(lo, s.tenonBottom, hi, bottom + 0.15)));
  return { outline: shape, spans };
}

/** The ring itself in its plan coords, with one mortise per tenon. */
export function ringShape(s: SupportSpec, v: Values, tenons: { plane: Plane; spans: [number, number][] }[]): Shape {
  const ring = s.inner > 0 ? difference(union([circlePath(0, 0, s.outer)]), union([circlePath(0, 0, s.inner)])) : union([circlePath(0, 0, s.outer)]);
  const c = v.supportClearance;
  const hw = v.thickness / 2 + c;
  const slots: Path[] = [];
  for (const { plane, spans } of tenons) {
    const pt = (u: number, w: number): [number, number] => [
      plane.origin[0] + plane.u[0] * u + plane.normal[0] * w,
      -(plane.origin[2] + plane.u[2] * u + plane.normal[2] * w),
    ];
    for (const [a, z] of spans) slots.push([pt(a - c, -hw), pt(z + c, -hw), pt(z + c, hw), pt(a - c, hw)]);
  }
  return slots.length ? difference(ring, union(slots)) : ring;
}
