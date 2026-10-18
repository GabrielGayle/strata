// 2D polygon geometry on top of Clipper. All laser parts live here as flat
// shapes; nothing is ever a 3D bevel.
import ClipperLib from 'clipper-lib';

export type Vec2 = [number, number];
export type Path = Vec2[];
export interface ExPoly {
  outer: Path;
  holes: Path[];
  /** Nesting depth: 0 = top-level piece, >0 = island sitting inside a hole. */
  depth?: number;
}
export type Shape = ExPoly[];

const S = 1000; // 1 µm resolution
/** Practical 'infinity' (mm) for half-planes. Clipper switches to slow BigInteger maths beyond ~47 m at µm scale. */
export const BIG = 20000;
const C = ClipperLib;
const CLIPPER_HI_RANGE =
  Number(C.ClipperBase?.hiRange) > 0 ? Number(C.ClipperBase.hiRange) : 4503599627370495;
/** mm. Stay below Clipper hiRange at 1 µm (hiRange / S ≈ 4.5e12 mm). */
export const MAX_COORD_MM = Math.min(1e9, CLIPPER_HI_RANGE / S / 4);

/** Clipper RangeTest / invalid input — never a browser `alert()`. */
export class GeometryRangeError extends Error {
  readonly operation: string;
  constructor(operation: string, message?: string) {
    super(message ?? `Coordinate outside allowed range in ${operation}()`);
    this.name = 'GeometryRangeError';
    this.operation = operation;
  }
}

export function isGeometryRangeError(err: unknown): boolean {
  return err instanceof GeometryRangeError || (err instanceof Error && err.name === 'GeometryRangeError');
}

// clipper-lib's Error() calls alert() and swallows the throw. Replace at load.
C.Error = (message: string) => {
  throw new GeometryRangeError('clipper', String(message ?? 'Clipper error'));
};

type IP = { X: number; Y: number };

function toIP(path: Path, op: string): IP[] {
  const out: IP[] = new Array(path.length);
  for (let i = 0; i < path.length; i++) {
    const x = path[i][0];
    const y = path[i][1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD_MM || Math.abs(y) > MAX_COORD_MM) {
      throw new GeometryRangeError(op);
    }
    const X = Math.round(x * S);
    const Y = Math.round(y * S);
    if (!Number.isFinite(X) || !Number.isFinite(Y) || Math.abs(X) > CLIPPER_HI_RANGE / 2 || Math.abs(Y) > CLIPPER_HI_RANGE / 2) {
      throw new GeometryRangeError(op);
    }
    out[i] = { X, Y };
  }
  return out;
}
function fromIP(path: IP[]): Path {
  const out: Path = new Array(path.length);
  for (let i = 0; i < path.length; i++) out[i] = [path[i].X / S, path[i].Y / S];
  return out;
}

export function signedArea(p: Path): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return -a / 2;
}

export function shapeToPaths(shape: Shape): Path[] {
  const out: Path[] = [];
  for (const e of shape) {
    out.push(signedArea(e.outer) >= 0 ? e.outer : [...e.outer].reverse());
    for (const h of e.holes) out.push(signedArea(h) <= 0 ? h : [...h].reverse());
  }
  return out;
}

function polyTreeToShape(tree: any): Shape {
  const out: Shape = [];
  const walk = (node: any, depth: number) => {
    for (const child of node.Childs()) {
      // child is an outer
      let outer = fromIP(child.Contour());
      if (signedArea(outer) < 0) outer = outer.reverse();
      const holes: Path[] = [];
      for (const h of child.Childs()) {
        let hp = fromIP(h.Contour());
        if (signedArea(hp) > 0) hp = hp.reverse();
        holes.push(hp);
        walk(h, depth + 1);
      }
      if (outer.length >= 3) out.push({ outer, holes, depth });
    }
  };
  walk(tree, 0);
  return out;
}

type Fill = 'nonzero' | 'evenodd';
const fillType = (f: Fill) => (f === 'evenodd' ? C.PolyFillType.pftEvenOdd : C.PolyFillType.pftNonZero);

function run(op: number, subj: Path[], clip: Path[], subjFill: Fill = 'nonzero', clipFill: Fill = 'nonzero', name = 'clip'): Shape {
  const c = new C.Clipper();
  if (subj.length) c.AddPaths(subj.map((p) => toIP(p, name)), C.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip.map((p) => toIP(p, name)), C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(op, tree, fillType(subjFill), fillType(clipFill));
  return polyTreeToShape(tree);
}

export function union(paths: Path[], fill: Fill = 'nonzero'): Shape {
  return run(C.ClipType.ctUnion, paths, [], fill, fill, 'union');
}
export function unionShapes(...shapes: Shape[]): Shape {
  return run(C.ClipType.ctUnion, shapes.flatMap(shapeToPaths), [], 'nonzero', 'nonzero', 'union');
}
export function difference(a: Shape, b: Shape): Shape {
  if (!b.length) return a;
  return run(C.ClipType.ctDifference, shapeToPaths(a), shapeToPaths(b), 'nonzero', 'nonzero', 'difference');
}
export function intersection(a: Shape, b: Shape): Shape {
  return run(C.ClipType.ctIntersection, shapeToPaths(a), shapeToPaths(b), 'nonzero', 'nonzero', 'intersection');
}
export function xor(a: Shape, b: Shape): Shape {
  return run(C.ClipType.ctXor, shapeToPaths(a), shapeToPaths(b), 'nonzero', 'nonzero', 'xor');
}

/** Offset a shape (positive grows outers and shrinks holes). */
export function offset(shape: Shape, delta: number, join: 'round' | 'miter' | 'square' = 'round', arcTol = 0.01): Shape {
  if (Math.abs(delta) < 1e-6) return shape;
  const jt = join === 'round' ? C.JoinType.jtRound : join === 'miter' ? C.JoinType.jtMiter : C.JoinType.jtSquare;
  const co = new C.ClipperOffset(2, arcTol * S);
  co.AddPaths(shapeToPaths(shape).map((p) => toIP(p, 'offset')), jt, C.EndType.etClosedPolygon);
  const tree = new C.PolyTree();
  co.Execute(tree, delta * S);
  return polyTreeToShape(tree);
}

/** Clip open polylines to the inside of a shape. */
export function clipLines(lines: Path[], shape: Shape): Path[] {
  if (!lines.length || !shape.length) return [];
  const c = new C.Clipper();
  c.AddPaths(lines.map((p) => toIP(p, 'clipLines')), C.PolyType.ptSubject, false);
  c.AddPaths(shapeToPaths(shape).map((p) => toIP(p, 'clipLines')), C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctIntersection, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return C.Clipper.OpenPathsFromPolyTree(tree).map(fromIP);
}

export function shapeArea(shape: Shape): number {
  let a = 0;
  for (const e of shape) {
    a += Math.abs(signedArea(e.outer));
    for (const h of e.holes) a -= Math.abs(signedArea(h));
  }
  return a;
}

export function pathLength(p: Path, closed = true): number {
  let l = 0;
  const n = p.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    l += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return l;
}

export function shapePerimeter(shape: Shape): number {
  let l = 0;
  for (const e of shape) {
    l += pathLength(e.outer);
    for (const h of e.holes) l += pathLength(h);
  }
  return l;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export function bboxOf(paths: Path[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths)
    for (const [x, y] of p) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return { minX, minY, maxX, maxY };
}
export const shapeBBox = (s: Shape) => bboxOf(s.map((e) => e.outer));

export function pointInPath(pt: Vec2, path: Path): boolean {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [xi, yi] = path[i];
    const [xj, yj] = path[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInShape(pt: Vec2, shape: Shape): boolean {
  for (const e of shape) {
    if (pointInPath(pt, e.outer) && !e.holes.some((h) => pointInPath(pt, h))) return true;
  }
  return false;
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): Path {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}
export function circlePath(cx: number, cy: number, r: number, segs?: number): Path {
  // enough sides that each chord is within 0.01 mm of the true circle
  const n = segs ?? Math.max(16, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.01 / Math.max(r, 0.01))))));
  const out: Path = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}
export const rect = (x0: number, y0: number, x1: number, y1: number): Shape => [{ outer: rectPath(x0, y0, x1, y1), holes: [] }];
export const circle = (cx: number, cy: number, r: number): Shape => [{ outer: circlePath(cx, cy, r), holes: [] }];

/** Ramer–Douglas–Peucker on a closed ring: drops points within tol of the simplified outline. */
export function simplifyPath(p: Path, tol: number): Path {
  const n = p.length;
  if (n < 5) return p;
  // split the ring at point 0 and the point farthest from it
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = p[a], B = p[b % n];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L = Math.hypot(dx, dy);
    let idx = -1, dmax = tol;
    for (let i = a + 1; i < b; i++) {
      const d = L > 1e-12 ? Math.abs((p[i][0] - A[0]) * dy - (p[i][1] - A[1]) * dx) / L : Math.hypot(p[i][0] - A[0], p[i][1] - A[1]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Path = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
  return out.length >= 3 ? out : p;
}

export function simplifyShape(shape: Shape, tol: number): Shape {
  return shape.map((e) => ({ outer: simplifyPath(e.outer, tol), holes: e.holes.map((h) => simplifyPath(h, tol)), depth: e.depth }));
}
