// Flat stack: plates laid flat, face to face, like a laminated block. Each layer
// is the horizontal section of the strata block (or source form) at its height,
// and an image is pressed down through the stack like a stamp: wherever the
// stamped surface dips below a layer, that layer is cut away, so dark (deep)
// areas run through more layers.
import { circlePath, difference, intersection, offset, pointInShape, rect, shapeArea, simplifyShape, union, type BBox, type Path, type Shape, type Vec2 } from './geom2d';
import { stackFrame, type HeightField } from './heightfield';
import { marchingSquares, sample, type Gray } from './image';
import type { Values } from './params';
import type { V3 } from './section';

/** Footprint of the flat stack in plan coords (x, -z): the plate width across, the stack run (less end margins) along. */
export function flatFootprint(v: Values): BBox {
  const f = stackFrame(v);
  const hs = Math.max(1, v.stackLength / 2 - v.endMargin);
  const ha = Math.max(1, v.plateWidth / 2);
  const ex = Math.abs(f.stack[0]) * hs + Math.abs(f.across[0]) * ha;
  const ez = Math.abs(f.stack[1]) * hs + Math.abs(f.across[1]) * ha;
  return { minX: -ex, minY: -ez, maxX: ex, maxY: ez };
}

export interface FlatStamp {
  /** Image coords (0..1) of a world point, or null outside the image window. */
  uv: (p: V3) => [number, number] | null;
  /** Depth field 0..1 (the top-impression profile field). */
  field: Gray;
}

/** Sampled surfaces over the footprint: H is the unstamped top, S the stamped one. */
export interface FlatGrid {
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  H: Float32Array;
  S: Float32Array;
  stamped: Uint8Array;
  /** True when the outline of each layer comes from H (strata), false for a form section. */
  fromField: boolean;
}

export function flatGrid(v: Values, fp: BBox, hf: HeightField | null, formTop: number, stamp: FlatStamp | null): FlatGrid {
  const w = fp.maxX - fp.minX, h = fp.maxY - fp.minY;
  const cell = Math.max(0.5, Math.min(v.sampleStep, Math.max(w, h) / 320));
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  const n = cols * rows;
  const H = new Float32Array(n);
  const S = new Float32Array(n);
  const stamped = new Uint8Array(n);
  const lv = new Float32Array(n);
  const steps = Math.round(v.topSteps);
  let datum = Infinity;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = fp.minX + c * cell, z = -(fp.minY + r * cell);
      H[i] = hf ? hf.at(x, z) : formTop;
      const uv = stamp ? stamp.uv([x, 0, z]) : null;
      if (!uv) continue;
      datum = Math.min(datum, H[i]);
      const level = sample(stamp!.field, uv[0], uv[1]);
      let f = v.imgTopMode === 'raise' ? 1 - level : level;
      if (steps > 0) f = Math.round(f * steps) / steps;
      lv[i] = f;
    }
  // the bottom layer is never cut through: it carries the pins and the picture's floor
  const floor = v.thickness * 1.001;
  for (let i = 0; i < n; i++) {
    S[i] = H[i];
    if (!(lv[i] > 0)) continue;
    const d = lv[i] * v.topDepth;
    const s = v.topFloor === 'follow' ? H[i] - d : Math.min(H[i], datum - d);
    S[i] = Math.max(floor, Math.min(H[i], s));
    if (S[i] < H[i] - 1e-6) stamped[i] = 1;
  }
  return { x0: fp.minX, y0: fp.minY, cell, cols, rows, H, S, stamped, fromField: !!hf };
}

function gridShape(g: FlatGrid, value: (i: number) => number): Shape {
  const field = new Float32Array(g.cols * g.rows);
  for (let i = 0; i < field.length; i++) field[i] = value(i);
  const loops = marchingSquares(field, g.cols, g.rows).map((l) => l.map(([x, y]) => [g.x0 + x * g.cell, g.y0 + y * g.cell] as Vec2));
  return loops.length ? union(loops, 'evenodd') : [];
}

/** Layer outline from the strata surface: wherever the block still stands at height y (above the base top). */
export function flatOutline(g: FlatGrid, fp: BBox, y: number): Shape {
  const s = gridShape(g, (i) => g.H[i] - y);
  return s.length ? simplifyShape(intersection(s, rect(fp.minX, fp.minY, fp.maxX, fp.maxY)), 0.02) : [];
}

/** Stamp cut for the layer at height y: where the stamped surface has dipped below it. */
export function flatStampCut(g: FlatGrid, y: number, minFeature: number, thickness: number): Shape {
  let any = false;
  for (let i = 0; i < g.S.length && !any; i++) if (g.stamped[i] && g.S[i] < y) any = true;
  if (!any) return [];
  let cut = gridShape(g, (i) => (g.stamped[i] ? y - g.S[i] : -1));
  const r = Math.max(0.3, minFeature / 2);
  cut = offset(offset(cut, -r), r); // drop slivers the laser can't hold
  // and pin-pricks smaller than the sheet is thick, which won't pierce cleanly
  const minArea = Math.PI * (thickness / 2) ** 2;
  return simplifyShape(cut.filter((ex) => shapeArea([ex]) >= minArea), 0.02);
}

/**
 * Registration pin positions: spread as far apart as possible inside the bottom
 * layer, preferring spots where the stack stays solid the highest so the pins
 * run through as many layers as they can.
 */
export function flatPinPoints(v: Values, g: FlatGrid, bottom: Shape, count: number, r: number): Vec2[] {
  if (count <= 0 || !bottom.length) return [];
  const inner = offset(bottom, -(r + Math.max(v.minFeature, 1) + 1));
  if (!inner.length) return [];
  const stride = Math.max(1, Math.round(6 / g.cell));
  const cands: { p: Vec2; s: number }[] = [];
  for (let row = 0; row < g.rows; row += stride)
    for (let c = 0; c < g.cols; c += stride) {
      const p: Vec2 = [g.x0 + c * g.cell, g.y0 + row * g.cell];
      if (pointInShape(p, inner)) cands.push({ p, s: g.S[row * g.cols + c] });
    }
  if (!cands.length) return [];
  let best = -Infinity, worst = Infinity;
  for (const c of cands) {
    best = Math.max(best, c.s);
    worst = Math.min(worst, c.s);
  }
  const keep = best - Math.max(2 * v.thickness, 0.3 * (best - worst));
  const pool = cands.filter((c) => c.s >= keep);
  // start at the far end of the stack run, then keep adding the point farthest from those chosen
  const f = stackFrame(v);
  const along = (p: Vec2) => p[0] * f.stack[0] - p[1] * f.stack[1];
  const out: Vec2[] = [pool.reduce((a, b) => (along(b.p) > along(a.p) ? b : a)).p];
  while (out.length < count) {
    let pick: Vec2 | null = null, far = -1;
    for (const c of pool) {
      const d = Math.min(...out.map((q) => Math.hypot(q[0] - c.p[0], q[1] - c.p[1])));
      if (d > far) {
        far = d;
        pick = c.p;
      }
    }
    if (!pick || far < 4 * r) break;
    out.push(pick);
  }
  return out;
}

/** True when a pin hole (plus a minimum-feature ring of material) sits wholly inside the layer. */
export function pinFits(shape: Shape, p: Vec2, r: number, minFeature: number): boolean {
  const ring = circlePath(p[0], p[1], r + Math.max(0.5, minFeature));
  return shapeArea(difference([{ outer: ring, holes: [] }], shape)) < 0.05;
}

/** Outline of a layer as closed polylines, for etching assembly guides onto the layer below. */
export function outlinePaths(shape: Shape): Path[] {
  return shape.flatMap((ex) => [ex.outer, ...ex.holes]).map((l) => [...l, l[0]]);
}
