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

type IP = { X: number; Y: number };

function toIP(path: Path): IP[] {
  const out: IP[] = new Array(path.length);
  for (let i = 0; i < path.length; i++) out[i] = { X: Math.round(path[i][0] * S), Y: Math.round(path[i][1] * S) };
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

function run(op: number, subj: Path[], clip: Path[], subjFill: Fill = 'nonzero', clipFill: Fill = 'nonzero'): Shape {
  const c = new C.Clipper();
  if (subj.length) c.AddPaths(subj.map(toIP), C.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip.map(toIP), C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(op, tree, fillType(subjFill), fillType(clipFill));
  return polyTreeToShape(tree);
}

export function union(paths: Path[], fill: Fill = 'nonzero'): Shape {
  return run(C.ClipType.ctUnion, paths, [], fill, fill);
}
export function unionShapes(...shapes: Shape[]): Shape {
  return run(C.ClipType.ctUnion, shapes.flatMap(shapeToPaths), [], 'nonzero', 'nonzero');
}
export function difference(a: Shape, b: Shape): Shape {
  if (!b.length) return a;
  return run(C.ClipType.ctDifference, shapeToPaths(a), shapeToPaths(b));
}
export function intersection(a: Shape, b: Shape): Shape {
  return run(C.ClipType.ctIntersection, shapeToPaths(a), shapeToPaths(b));
}
export function xor(a: Shape, b: Shape): Shape {
  return run(C.ClipType.ctXor, shapeToPaths(a), shapeToPaths(b));
}

/** Offset a shape (positive grows outers and shrinks holes). */
export function offset(shape: Shape, delta: number, join: 'round' | 'miter' | 'square' = 'round'): Shape {
  if (Math.abs(delta) < 1e-6) return shape;
  const jt = join === 'round' ? C.JoinType.jtRound : join === 'miter' ? C.JoinType.jtMiter : C.JoinType.jtSquare;
  const co = new C.ClipperOffset(2, 0.01 * S);
  co.AddPaths(shapeToPaths(shape).map(toIP), jt, C.EndType.etClosedPolygon);
  const tree = new C.PolyTree();
  co.Execute(tree, delta * S);
  return polyTreeToShape(tree);
}

/** Clip open polylines to the inside of a shape. */
export function clipLines(lines: Path[], shape: Shape): Path[] {
  if (!lines.length || !shape.length) return [];
  const c = new C.Clipper();
  c.AddPaths(lines.map(toIP), C.PolyType.ptSubject, false);
  c.AddPaths(shapeToPaths(shape).map(toIP), C.PolyType.ptClip, true);
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
  const n = segs ?? Math.max(12, Math.min(96, Math.ceil(r * 2.5)));
  const out: Path = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}
export const rect = (x0: number, y0: number, x1: number, y1: number): Shape => [{ outer: rectPath(x0, y0, x1, y1), holes: [] }];
export const circle = (cx: number, cy: number, r: number): Shape => [{ outer: circlePath(cx, cy, r), holes: [] }];

export function transformShape(shape: Shape, f: (p: Vec2) => Vec2): Shape {
  return shape.map((e) => ({ outer: e.outer.map(f), holes: e.holes.map((h) => h.map(f)), depth: e.depth }));
}

/** Remove near-duplicate and collinear points. */
export function cleanShape(shape: Shape, dist = 0.005): Shape {
  const cleanPath = (p: Path) => fromIP(C.Clipper.CleanPolygon(toIP(p), dist * S));
  return shape
    .map((e) => ({ outer: cleanPath(e.outer), holes: e.holes.map(cleanPath).filter((h) => h.length >= 3), depth: e.depth }))
    .filter((e) => e.outer.length >= 3);
}
