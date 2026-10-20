// Metal on metal: every pair of laser-cut parts is checked for solid steel in
// the same place. Each part is its outline extruded through its thickness about
// its plane, so the test is exact: parallel parts overlap where their slabs do
// and their outlines meet; crossing parts overlap where the shadow of one part's
// steel inside the other's slab lands on that part's outline.
import * as THREE from 'three';
import { intersection, shapeArea, shapeBBox, signedArea, union, type BBox, type Path, type Shape, type Vec2 } from './geom2d';
import { cached } from './memo';
import { planeToWorld, type Plane, type V3 } from './section';
import type { Part } from './slicer';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Steel this far inside both faces counts; touching faces (a weld, a glued layer, a snug slot) do not. */
export const OVERLAP_SKIN = 0.02;
/** Overlap smaller than this (mm², in the part's own plane) is rounding, not steel. */
export const OVERLAP_MIN_AREA = 0.5;

/** A flat part: its outline extruded through its thickness about its plane. */
export type Slab = Pick<Part, 'plane' | 'thickness' | 'shape' | 'bbox'>;

export interface Overlap {
  a: Part;
  b: Part;
  /** Area of a's face that b's steel sits on (mm²). */
  area: number;
  /** Where on a (plate coords). */
  at: Vec2;
  /** The overlap on a (plate coords). */
  region: Shape;
}

interface Box {
  min: V3;
  max: V3;
}

function worldBox(p: Part): Box {
  const { minX, minY, maxX, maxY } = p.bbox;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]])
    for (const w of [-p.thickness / 2, p.thickness / 2]) {
      const q = planeToWorld(p.plane, x, y, w);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], q[i]);
        max[i] = Math.max(max[i], q[i]);
      }
    }
  return { min, max };
}

const boxesMeet = (a: Box, b: Box) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - OVERLAP_SKIN && b.min[i] < a.max[i] - OVERLAP_SKIN);

/** Map paths in b's plane (at depth w) into a's plate coords. */
function toPlane(paths: Path[], from: Plane, w: number, to: Plane): Path[] {
  return paths.map((p) =>
    p.map(([x, y]) => {
      const r = sub(planeToWorld(from, x, y, w), to.origin);
      return [dot(r, to.u), dot(r, to.v)] as Vec2;
    }),
  );
}

const pathsOf = (s: Shape): Path[] => s.flatMap((e) => [e.outer, ...e.holes]);

const boxesCross = (p: BBox, q: BBox) => p.minX < q.maxX && q.minX < p.maxX && p.minY < q.maxY && q.minY < p.maxY;
const pad = (b: BBox, d: number): BBox => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d });

/** The part of a shape inside a box (Sutherland–Hodgman on each ring), without handing the whole outline to Clipper. */
function clipToBox(shape: Shape, b: BBox): Shape {
  const edges: [(p: Vec2) => number, number][] = [
    [(p) => p[0] - b.minX, 0],
    [(p) => b.maxX - p[0], 0],
    [(p) => p[1] - b.minY, 1],
    [(p) => b.maxY - p[1], 1],
  ];
  const rings: Path[] = [];
  for (let ring of pathsOf(shape)) {
    for (const [side] of edges) {
      if (ring.length < 3) break;
      const out: Path = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        const dp = side(p);
        const dq = side(q);
        if (dp >= 0) out.push(p);
        if (dp >= 0 !== dq >= 0) {
          const k = dp / (dp - dq);
          out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]);
        }
      }
      ring = out;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings.length ? union(rings, 'evenodd') : [];
}

// overlaps are cached on a's outline, by b's outline and both planes: unchanged parts cost nothing on the next check
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => ids.get(o) ?? (ids.set(o, nextId), nextId++);
const planeKey = (p: Plane) => [...p.origin, ...p.normal, ...p.u].map((x) => x.toFixed(4)).join(',');

/**
 * Where b's steel sits inside a's solid, in a's plate coords (empty when they don't meet). Faces
 * closer than `skin` count as touching; 0 gives the whole footprint b needs in a.
 */
export function overlapRegion(a: Slab, b: Slab, skin = OVERLAP_SKIN): Shape {
  const key = `overlap:${idOf(b.shape)}:${planeKey(a.plane)}:${planeKey(b.plane)}:${a.thickness}:${b.thickness}:${skin}`;
  return cached(a.shape, key, () => region(a, b, skin));
}

function region(a: Slab, b: Slab, skin: number): Shape {
  const A = a.plane;
  const B = b.plane;
  const ha = a.thickness / 2 - skin;
  const hb = b.thickness / 2 - skin;
  if (ha <= 0 || hb <= 0) return [];
  const cos = Math.abs(dot(A.normal, B.normal));
  if (cos > 0.9999) {
    // side by side: the slabs share some depth, then the outlines must meet
    const d = Math.abs(dot(sub(B.origin, A.origin), A.normal));
    if (d >= ha + hb) return [];
    return intersection(a.shape, union(toPlane(pathsOf(b.shape), B, 0, A), 'evenodd'));
  }
  // crossing: only a's steel under the box round b's steel in a's slab, and b's in a box the other
  // way round, can meet (a steel base with a slot for every plate is a big outline)
  const box = footprintBox({ plane: A, thickness: 2 * ha }, { plane: B, thickness: 2 * hb, shape: b.shape });
  if (!box || !boxesCross(box, a.bbox)) return [];
  const back = footprintBox({ plane: B, thickness: 2 * hb }, { plane: A, thickness: 2 * ha, shape: a.shape });
  if (!back || !boxesCross(back, b.bbox)) return [];
  const near = clipToBox(a.shape, pad(box, 1));
  if (shapeArea(near) <= 1e-6) return [];
  const bNear = clipToBox(b.shape, pad(back, 1));
  if (shapeArea(bNear) <= 1e-6) return [];
  // then exactly: cut b into triangles; each one's prism inside a's slab is convex, so its shadow on a
  // is the hull of its corners in the slab and where its edges cross the slab's faces
  const shadows: Path[] = [];
  for (const ex of bNear) {
    const contour = ex.outer.map(([x, y]) => new THREE.Vector2(x, y));
    const holes = ex.holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
    const pts = [...ex.outer, ...ex.holes.flat()];
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      const corners = slabCorners(A, ha, [pts[i], pts[j], pts[k]], B, hb);
      if (corners.length < 3) continue;
      const hull = convexHull(corners);
      if (hull.length >= 3 && Math.abs(signedArea(hull)) > 1e-9) shadows.push(hull);
    }
  }
  if (!shadows.length) return [];
  return intersection(near, union(shadows));
}

/** Corners (in a's plate coords) of a triangular prism of b cut by a's slab: corners inside it, and edge crossings of its faces. */
function slabCorners(A: Plane, h: number, tri: Vec2[], B: Plane, hb: number): Vec2[] {
  const w = tri.flatMap(([x, y]) => [planeToWorld(B, x, y, -hb), planeToWorld(B, x, y, hb)]);
  const out: Vec2[] = [];
  const dist = (q: V3) => dot(sub(q, A.origin), A.normal);
  const put = (q: V3) => {
    const r = sub(q, A.origin);
    out.push([dot(r, A.u), dot(r, A.v)]);
  };
  const edge = (p: V3, q: V3) => {
    const dp = dist(p);
    const dq = dist(q);
    for (const f of [-h, h]) {
      if ((dp - f) * (dq - f) >= 0) continue;
      const k = (f - dp) / (dq - dp);
      put([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]);
    }
  };
  for (const q of w) if (Math.abs(dist(q)) <= h) put(q);
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    edge(w[2 * i], w[2 * j]);
    edge(w[2 * i + 1], w[2 * j + 1]);
    edge(w[2 * i], w[2 * i + 1]);
  }
  return out;
}

/** Counter-clockwise convex hull (monotone chain). */
function convexHull(pts: Vec2[]): Path {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The box (in a's plate coords) round everywhere b's steel passes through a's slab, or null. Exact:
 * the extremes of that solid are corners of b inside the slab or where b's edges cross its faces.
 */
export function footprintBox(a: Pick<Slab, 'plane' | 'thickness'>, b: Pick<Slab, 'plane' | 'thickness' | 'shape'>): BBox | null {
  const A = a.plane;
  const h = a.thickness / 2;
  const [ox, oy, oz] = A.origin;
  const [nx, ny, nz] = A.normal;
  const [ux, uy, uz] = A.u;
  const [vx, vy, vz] = A.v;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number, z: number) => {
    const rx = x - ox, ry = y - oy, rz = z - oz;
    const px = rx * ux + ry * uy + rz * uz;
    const py = rx * vx + ry * vy + rz * vz;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  };
  // b's edges: round each outline at both faces, and through the thickness at every corner
  const edge = (w: Float64Array, i: number, j: number) => {
    const dp = (w[i] - ox) * nx + (w[i + 1] - oy) * ny + (w[i + 2] - oz) * nz;
    const dq = (w[j] - ox) * nx + (w[j + 1] - oy) * ny + (w[j + 2] - oz) * nz;
    if (dp <= h && dp >= -h) add(w[i], w[i + 1], w[i + 2]);
    for (const f of [-h, h]) {
      if ((dp - f) * (dq - f) >= 0) continue;
      const k = (f - dp) / (dq - dp);
      add(w[i] + (w[j] - w[i]) * k, w[i + 1] + (w[j + 1] - w[i + 1]) * k, w[i + 2] + (w[j + 2] - w[i + 2]) * k);
    }
  };
  for (const w of worldRings(b)) {
    // w holds each corner on the back face, then the same corner on the front face
    const n = w.length / 6;
    for (let k = 0; k < n; k++) {
      const i = k * 6;
      const j = ((k + 1) % n) * 6;
      edge(w, i, j);
      edge(w, i + 3, j + 3);
      edge(w, i, i + 3);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Every outline corner of a part in world space, on both faces, cached on the outline. */
function worldRings(b: Pick<Slab, 'plane' | 'thickness' | 'shape'>): Float64Array[] {
  return cached(b.shape, `world:${planeKey(b.plane)}:${b.thickness}`, () => {
    const hb = b.thickness / 2;
    return pathsOf(b.shape).map((path) => {
      const w = new Float64Array(path.length * 6);
      path.forEach(([x, y], k) => {
        w.set(planeToWorld(b.plane, x, y, -hb), k * 6);
        w.set(planeToWorld(b.plane, x, y, hb), k * 6 + 3);
      });
      return w;
    });
  });
}

/**
 * Every pair of parts whose steel occupies the same space. Pieces of one plate never meet
 * (they come from one outline), so they are skipped.
 */
export function findOverlaps(parts: Part[], minArea = OVERLAP_MIN_AREA): Overlap[] {
  if (parts.length < 2) return [];
  const boxes = parts.map(worldBox);
  const order = parts.map((_, i) => i).sort((i, j) => boxes[i].min[0] - boxes[j].min[0]);
  const out: Overlap[] = [];
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (boxes[j].min[0] >= boxes[i].max[0] - OVERLAP_SKIN) break;
      const a = parts[i];
      const b = parts[j];
      if (a.plateKey === b.plateKey || !boxesMeet(boxes[i], boxes[j])) continue;
      let region = overlapRegion(a, b);
      let on = a;
      let other = b;
      if (shapeArea(region) <= minArea) {
        // crossing parts: b's face may show the overlap better than a's edge does
        const back = overlapRegion(b, a);
        if (shapeArea(back) <= minArea) continue;
        region = back;
        on = b;
        other = a;
      }
      const rb = shapeBBox(region);
      out.push({ a: on, b: other, area: shapeArea(region), at: [(rb.minX + rb.maxX) / 2, (rb.minY + rb.maxY) / 2], region });
    }
  }
  return out;
}
