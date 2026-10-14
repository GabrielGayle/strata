// The slicer: turns forms + parameters into flat, laser-ready plates.
// Every outline and every cavity is computed per plate in 2D, then extruded
// straight through the sheet, so every edge is cut at 90°.
import type { Values } from './params';
import { cached } from './memo';
import {
  bboxOf,
  circlePath,
  clipLines,
  difference,
  intersection,
  offset,
  pointInShape,
  rect,
  shapeArea,
  shapeBBox,
  shapePerimeter,
  union,
  unionShapes,
  simplifyShape,
  xor,
  type BBox,
  type ExPoly,
  type Path,
  type Shape,
  type Vec2,
  BIG,
} from './geom2d';
import { offsetPlane, planeToWorld, sectionShape, type Plane, type V3 } from './section';
import { stackFrame, type HeightField } from './heightfield';
import type { IndexedMesh } from './forms';
import { distanceInside, marchingSquares, sample, type Gray } from './image';
import { strokeTextCentered, textWidth } from './strokefont';
import { addTenons, baseChamfers, ringShape, supportPlane, supportSpec, type SupportSpec } from './base';

export type Family = 'P' | 'X' | 'R' | 'S';

export interface PlateDef {
  key: string;
  family: Family;
  index: number;
  count: number;
  plane: Plane;
  u0: number;
  u1: number;
}

export interface Part {
  id: string;
  plateKey: string;
  family: Family;
  index: number;
  piece: number;
  plane: Plane;
  thickness: number;
  shape: Shape; // exactly one ExPoly: one physical piece
  etch: Path[];
  labelPaths: Path[];
  labelAt: Vec2 | null;
  area: number;
  perimeter: number;
  bbox: BBox;
  anchored: boolean;
  kind: 'plate';
}

export interface PlateInfo {
  def: PlateDef;
  parts: Part[];
  /** Mean width of the bevel a 3D boolean would have left (front vs back section). */
  bevel: number;
  /** Area of insert material that would hit the plate (mm²). */
  collision: number;
  collisionAt: Vec2 | null;
  islands: number;
  cavity: Shape;
  sweptInsert: Shape;
  /** Tenons dropped into the embedded support ring. */
  tenons: number;
}

export interface FrontWindow {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export interface SliceResult {
  plates: PlateInfo[];
  parts: Part[];
  warnings: string[];
  front: FrontWindow | null;
  top: TopWindow | null;
  support: SupportSpec | null;
}

export interface SliceInput {
  v: Values;
  hf: HeightField | null;
  source: IndexedMesh | null;
  insert: IndexedMesh | null;
  front: Gray | null;
  top?: Gray | null;
}

const UP: V3 = [0, 1, 0];
const crossUp = (n: V3): V3 => [n[2], 0, -n[0]]; // up × n

function makePlane(origin: V3, normal: V3): Plane {
  return { origin, normal, u: crossUp(normal), v: UP };
}

export const baseTop = (v: Values) => (v.baseOn ? v.baseHeight : 0);
export const embedOf = (v: Values) => (v.baseOn ? v.embedDepth : 0);

export function plateDefs(v: Values): PlateDef[] {
  const top = baseTop(v);
  const defs: PlateDef[] = [];
  if (v.sliceMode === 'radial') {
    const n = v.radialCount;
    const ch = v.baseOn ? baseChamfers(v) : { corner: 0, edge: 0 };
    const m = Math.max(v.sideMargin, ch.edge);
    const hx = Math.max(1, v.baseLength / 2 - m);
    const hz = Math.max(1, v.baseWidth / 2 - m);
    // stay the same margin inside a chamfered corner
    const diag = ch.corner > 0 ? v.baseLength / 2 + v.baseWidth / 2 - ch.corner - m * Math.SQRT2 : Infinity;
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const R = Math.min(Math.abs(c) > 1e-9 ? hx / Math.abs(c) : Infinity, Math.abs(s) > 1e-9 ? hz / Math.abs(s) : Infinity, diag / (Math.abs(c) + Math.abs(s)));
      const normal: V3 = [-s, 0, c];
      const plane: Plane = { origin: [0, top, 0], normal, u: [c, 0, s], v: UP };
      defs.push({ key: `R${k}`, family: 'R', index: k, count: n, plane, u0: Math.min(v.radialHub, R - 5), u1: R });
    }
    return defs;
  }
  const f = stackFrame(v);
  const n = v.plateCount;
  const w = v.plateWidth;
  for (let i = 0; i < n; i++) {
    const s = (i - (n - 1) / 2) * v.pitch;
    defs.push({
      key: `P${i}`,
      family: 'P',
      index: i,
      count: n,
      plane: makePlane([s * f.stack[0], top, s * f.stack[1]], [f.stack[0], 0, f.stack[1]]),
      u0: -w / 2,
      u1: w / 2,
    });
  }
  if (v.sliceMode === 'waffle') {
    const m = v.crossCount;
    const cp = w / m;
    const ext = Math.min(((n - 1) / 2) * v.pitch + v.pitch / 2, f.stackLen / 2 - Math.min(v.sideMargin, f.stackLen / 4));
    for (let j = 0; j < m; j++) {
      const a = -w / 2 + cp * (j + 0.5);
      defs.push({
        key: `X${j}`,
        family: 'X',
        index: j,
        count: m,
        plane: makePlane([a * f.across[0], top, a * f.across[1]], [f.across[0], 0, f.across[1]]),
        u0: -ext,
        u1: ext,
      });
    }
  }
  return defs;
}

function strataOutline(def: PlateDef, hf: HeightField, v: Values): Shape {
  const { u0, u1, plane } = def;
  const step = Math.max(0.5, v.sampleStep);
  const n = Math.max(2, Math.ceil((u1 - u0) / step));
  const top: Path = [];
  for (let k = 0; k <= n; k++) {
    const u = u0 + ((u1 - u0) * k) / n;
    const p = planeToWorld(plane, u, 0);
    top.push([u, hf.at(p[0], p[2])]);
  }
  // strata flow: low-pass the top line (two box passes ≈ a gentle gaussian) into long curves
  const win = Math.round(v.edgeFlow / 2 / ((u1 - u0) / n));
  if (win >= 1) {
    for (let pass = 0; pass < 2; pass++) {
      const h = top.map((q) => q[1]);
      for (let k = 0; k < top.length; k++) {
        let sum = 0, cnt = 0;
        for (let j = Math.max(0, k - win); j <= Math.min(top.length - 1, k + win); j++) {
          sum += h[j];
          cnt++;
        }
        top[k][1] = sum / cnt;
      }
    }
  }
  const e = embedOf(v);
  const inset = Math.max(0, Math.min(v.tabInset, (u1 - u0) / 2 - 5));
  const poly: Path = [];
  if (e > 0 && inset > 0) poly.push([u0 + inset, -e], [u1 - inset, -e], [u1 - inset, 0], [u1, 0]);
  else if (e > 0) poly.push([u0, -e], [u1, -e]);
  else poly.push([u0, 0], [u1, 0]);
  for (let k = top.length - 1; k >= 0; k--) poly.push(top[k]);
  if (e > 0 && inset > 0) poly.push([u0, 0], [u0 + inset, 0]);
  return simplifyShape(union([poly]), 0.01);
}

function formOutline(def: PlateDef, mesh: IndexedMesh, v: Values): Shape {
  let sec = sectionShape(mesh, def.plane);
  if (def.family === 'R') sec = intersection(sec, rect(def.u0, -BIG, BIG, BIG));
  if (!sec.length) return [];
  const e = embedOf(v);
  if (e <= 0) return sec;
  const band = intersection(sec, rect(-BIG, 0, BIG, 0.3));
  if (!band.length) return sec;
  const bb = shapeBBox(band);
  const inset = Math.max(0, Math.min(v.tabInset, (bb.maxX - bb.minX) / 2 - 3));
  return unionShapes(sec, rect(bb.minX + inset, -e, bb.maxX - inset, 0.15));
}

function tabRange(outline: Shape, e: number): [number, number] | null {
  const band = intersection(outline, rect(-BIG, -e + 0.5, BIG, -0.5));
  if (!band.length) return null;
  const bb = shapeBBox(band);
  return [bb.minX, bb.maxX];
}

interface FrontCtx {
  img: Gray;
  win: FrontWindow; // fitted image rectangle in plate coords
}

function frontContext(v: Values, img: Gray | null, defs: PlateDef[], hf: HeightField | null): FrontCtx | null {
  if (!img || v.sliceMode !== 'parallel') return null;
  if (v.imgFrontMode === 'off' && v.etchMode === 'off') return null;
  const p = defs.find((d) => d.family === 'P');
  if (!p) return null;
  const m = v.frontMargin;
  const u0 = p.u0 + m, u1 = p.u1 - m;
  const topV = hf ? hf.min : v.stackHeight;
  const v0 = m, v1 = topV - m;
  if (u1 - u0 < 5 || v1 - v0 < 5) return null;
  const ar = img.w / img.h;
  const w = u1 - u0, h = v1 - v0;
  let win: FrontWindow;
  if (w / h > ar) {
    const fw = h * ar;
    win = { u0: (u0 + u1) / 2 - fw / 2, u1: (u0 + u1) / 2 + fw / 2, v0, v1 };
  } else {
    const fh = w / ar;
    win = { u0, u1, v0: (v0 + v1) / 2 - fh / 2, v1: (v0 + v1) / 2 + fh / 2 };
  }
  return { img, win };
}

/** Darkness 0..1 of the front image at plate coords. Looking at the stack from the front, image-right is -u. */
function darkAt(ctx: FrontCtx, u: number, vv: number): number {
  const { win } = ctx;
  if (u < win.u0 || u > win.u1 || vv < win.v0 || vv > win.v1) return 0;
  return 1 - sample(ctx.img, (win.u1 - u) / (win.u1 - win.u0), (win.v1 - vv) / (win.v1 - win.v0));
}

function fieldLoops(ctx: FrontCtx, level: number, strength: number): { loops: Path[]; cell: number } {
  const { win } = ctx;
  const w = win.u1 - win.u0, h = win.v1 - win.v0;
  const cell = Math.min(5, Math.max(1.2, w / 110));
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  const field = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) field[r * cols + c] = darkAt(ctx, win.u0 + c * cell, win.v0 + r * cell) * strength - level;
  const loops = marchingSquares(field, cols, rows).map((l) => l.map(([x, y]) => [win.u0 + x * cell, win.v0 + y * cell] as Vec2));
  return { loops, cell };
}

function frontCut(def: PlateDef, outline: Shape, v: Values, ctx: FrontCtx): Shape {
  if (def.family !== 'P' || def.index >= v.frontDepth) return [];
  const cut = imageCut(def, v, ctx);
  if (!cut.length) return [];
  return intersection(cut, offset(outline, -v.frontMargin));
}

/**
 * The image-driven cut-out for one plate before it is framed by the plate's
 * outline. It depends only on the image, its window and a few image settings,
 * so it is cached on the image and survives edits to the strata, edges, etc.
 */
function imageCut(def: PlateDef, v: Values, ctx: FrontCtx): Shape {
  const { win } = ctx;
  const level = v.imgFrontMode === 'layers' ? (def.index + 0.5) / v.frontDepth : 0;
  const key = [win.u0, win.u1, win.v0, win.v1, v.imgFrontMode, level, v.imgFrontStrength, v.minFeature, v.halftoneSpacing].join(',');
  return cached(ctx.img, key, () => imageCutUncached(level, v, ctx));
}

function imageCutUncached(level: number, v: Values, ctx: FrontCtx): Shape {
  const strength = v.imgFrontStrength;
  let cut: Shape = [];
  if (v.imgFrontMode === 'layers') {
    const { loops } = fieldLoops(ctx, level, strength);
    if (!loops.length) return [];
    cut = union(loops, 'evenodd');
    const r = Math.max(0.3, v.minFeature / 2);
    cut = offset(offset(cut, -r), r); // drop slivers the laser can't hold
  } else if (v.imgFrontMode === 'halftone') {
    const sp = v.halftoneSpacing;
    const { win } = ctx;
    const circles: Path[] = [];
    const minD = Math.max(v.minFeature, 1.5);
    const dy = sp * 0.866;
    for (let row = 0, vv = win.v0 + sp / 2; vv <= win.v1 - sp / 2 + 1e-6; row++, vv += dy) {
      for (let u = win.u0 + sp / 2 + (row % 2 ? sp / 2 : 0); u <= win.u1 - sp / 2 + 1e-6; u += sp) {
        const d = darkAt(ctx, u, vv);
        const r = 0.5 * (sp - v.minFeature) * Math.sqrt(Math.min(1, d * strength * 1.6));
        if (2 * r >= minD) circles.push(circlePath(u, vv, r));
      }
    }
    if (!circles.length) return [];
    cut = union(circles);
  }
  return cut;
}

function frontEtch(def: PlateDef, v: Values, ctx: FrontCtx): Path[] {
  if (def.family !== 'P' || v.etchMode === 'off') return [];
  const strength = v.imgFrontMode === 'off' ? 1 : Math.max(0.05, v.imgFrontStrength);
  const { win } = ctx;
  if (v.etchMode === 'hatch') {
    // identical lines on every plate, so they line up across the stack
    const lines: Path[] = [];
    const step = Math.max(0.5, (win.u1 - win.u0) / 200);
    const thr = Math.max(0.02, 1 - strength);
    for (let vv = win.v0 + v.etchSpacing / 2; vv < win.v1; vv += v.etchSpacing) {
      let start: number | null = null;
      for (let u = win.u0; u <= win.u1 + step / 2; u += step) {
        const on = u <= win.u1 && darkAt(ctx, u, vv) > thr;
        if (on && start === null) start = u;
        if (!on && start !== null) {
          if (u - start > 1) lines.push([[start, vv], [u - step, vv]]);
          start = null;
        }
      }
    }
    return lines;
  }
  // contour: one iso-line per plate, so the stack spreads the tonal range
  const level = (def.index + 0.5) / def.count;
  const { loops } = fieldLoops(ctx, level, strength);
  return loops.filter((l) => l.length > 4).map((l) => [...l, l[0]]);
}

// ---------------------------------------------------------------------------
// Top-surface impression: looking down on the stack, every plate's top edge is
// cut down where its strip of the image is dark, so the image reads across the
// whole top surface. Steps give crisp vertical risers, like layered cut-outs.

export interface TopWindow {
  /** Screen axes of the plan view seen from the front end: right and away-from-viewer (stack), in world XZ. */
  right: [number, number];
  stack: [number, number];
  r0: number;
  r1: number;
  s0: number;
  s1: number;
  /** quarter turns of the image on the surface (clockwise, seen from above with the front at the bottom) */
  turns: number;
}

/**
 * Image rectangle on the footprint. Viewed from above with the front plate at
 * the bottom (the stack running away from you), the image sits upright:
 * image right = right when standing at the front, image top = the far end.
 */
export function topWindow(v: Values, img: Gray, defs: PlateDef[]): TopWindow | null {
  if (!defs.length) return null;
  const f = stackFrame(v);
  const stack: [number, number] = [f.stack[0], f.stack[1]];
  const right: [number, number] = [-f.stack[1], f.stack[0]];
  let r0 = Infinity, r1 = -Infinity, s0 = Infinity, s1 = -Infinity;
  for (const d of defs)
    for (const u of [d.u0, d.u1]) {
      const p = planeToWorld(d.plane, u, 0);
      const r = p[0] * right[0] + p[2] * right[1];
      const sv = p[0] * stack[0] + p[2] * stack[1];
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
      s0 = Math.min(s0, sv);
      s1 = Math.max(s1, sv);
    }
  const m = v.topMargin;
  r0 += m;
  r1 -= m;
  s0 += m;
  s1 -= m;
  if (r1 - r0 < 2 || s1 - s0 < 2) return null;
  const turns = ((Math.round(Number(v.topRotate) / 90) % 4) + 4) % 4;
  const ar = turns % 2 ? img.h / img.w : img.w / img.h; // on-surface width runs along `right`, height along `stack`
  let w = r1 - r0, h = s1 - s0;
  if (w / h > ar) w = h * ar;
  else h = w / ar;
  w *= v.topScale;
  h *= v.topScale;
  const cr = (r0 + r1) / 2 + v.topX * right[0] + v.topZ * right[1];
  const cs = (s0 + s1) / 2 + v.topX * stack[0] + v.topZ * stack[1];
  return { right, stack, r0: cr - w / 2, r1: cr + w / 2, s0: cs - h / 2, s1: cs + h / 2, turns };
}

/** Image coordinates (0..1, y down) of a world point, or null outside the image. */
export function topUV(win: TopWindow, p: V3): [number, number] | null {
  const r = p[0] * win.right[0] + p[2] * win.right[1];
  const sv = p[0] * win.stack[0] + p[2] * win.stack[1];
  if (r < win.r0 || r > win.r1 || sv < win.s0 || sv > win.s1) return null;
  const a = (r - win.r0) / (win.r1 - win.r0); // across the window, left → right
  const b = (win.s1 - sv) / (win.s1 - win.s0); // far end → front
  switch (win.turns) {
    case 1:
      return [b, 1 - a];
    case 2:
      return [1 - a, 1 - b];
    case 3:
      return [1 - b, a];
    default:
      return [a, b];
  }
}

/**
 * Depth field (0..1) for a top-surface profile. For "tone" it is the image's
 * darkness above the threshold; for pillow / balloon / chamfer it comes from
 * each point's distance to the edge of the dark shape, so a flat silhouette
 * inflates from its outline.
 */
export function topProfileField(v: Values, img: Gray, win: TopWindow): Gray {
  const thr = Math.min(0.99, v.topThreshold);
  const n = img.w * img.h;
  const data = new Float32Array(n);
  if (v.topProfile === 'tone' || !v.topProfile) {
    for (let i = 0; i < n; i++) data[i] = Math.max(0, Math.min(1, (1 - img.data[i] - thr) / (1 - thr)));
    return { w: img.w, h: img.h, data };
  }
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = 1 - img.data[i] > thr ? 1 : 0;
  const dist = distanceInside(inside, img.w, img.h);
  // image columns run along `right` unless the image is turned a quarter
  const mmPerPx = (win.turns % 2 ? win.s1 - win.s0 : win.r1 - win.r0) / img.w;
  let R = Math.max(0.5, v.topBillow) / mmPerPx;
  if (v.topProfile === 'balloon') {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, dist[i]);
    R = Math.max(1, max);
  }
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    const t = Math.min(1, dist[i] / R);
    data[i] = v.topProfile === 'chamfer' ? t : Math.sqrt(1 - (1 - t) * (1 - t)); // quarter-circle shoulder
  }
  return { w: img.w, h: img.h, data };
}

/** Highest point of the outline above u (the top edge), or null if the vertical misses it. */
export function topAt(shape: Shape, u: number): number | null {
  let best = -Infinity;
  for (const ex of shape) {
    const p = ex.outer;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[j], b = p[i];
      if (a[0] <= u !== b[0] <= u) {
        const y = a[1] + ((u - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
        if (y > best) best = y;
      }
    }
  }
  return best === -Infinity ? null : best;
}

function topCarve(def: PlateDef, outline: Shape, v: Values, img: Gray, win: TopWindow, datum: number): Shape {
  const step = Math.min(1, v.sampleStep);
  const n = Math.max(2, Math.ceil((def.u1 - def.u0) / step));
  const us: number[] = [];
  const tops: number[] = [];
  const lv: number[] = [];
  const steps = Math.round(v.topSteps);
  for (let k = 0; k <= n; k++) {
    const u = def.u0 + ((def.u1 - def.u0) * k) / n;
    const t = topAt(outline, u);
    us.push(u);
    tops.push(t ?? 0);
    const p = planeToWorld(def.plane, u, 0);
    let f = 0;
    const uv = t !== null && t > 0 ? topUV(win, p) : null;
    if (uv) {
      const level = sample(img, uv[0], uv[1]); // img is the profile field (0..1 depth)
      f = v.imgTopMode === 'raise' ? 1 - level : level;
      if (steps > 0) f = Math.round(f * steps) / steps;
    }
    lv.push(f);
  }
  // drop runs narrower than the minimum feature (slivers of material or of cut). Stepped
  // profiles clean up every terrace; smooth ones only where the cut starts and stops.
  const minRun = Math.max(1, Math.ceil(Math.max(v.minFeature, 0.5) / step));
  const key = (x: number) => (steps > 0 ? x : x > 0 ? 1 : 0);
  for (let pass = 0; pass < 2; pass++) {
    let a = 0;
    while (a < lv.length) {
      let b = a;
      while (b + 1 < lv.length && key(lv[b + 1]) === key(lv[a])) b++;
      if (b - a + 1 < minRun && (a > 0 || b < lv.length - 1)) {
        const fill = a > 0 ? lv[a - 1] : lv[b + 1];
        for (let k = a; k <= b; k++) lv[k] = steps > 0 || key(fill) === 0 ? fill : Math.max(lv[k], fill);
      }
      a = b + 1;
    }
  }
  // flat: every step is a level terrace below the lowest top inside the image; follow: offset from the local top
  const depthAt = (k: number) => {
    if (lv[k] <= 0) return 0;
    const d = v.topFloor === 'follow' ? lv[k] * v.topDepth : tops[k] - (datum - lv[k] * v.topDepth);
    return Math.max(0, Math.min(d, tops[k] - 5));
  };
  const ceiling = Math.max(...tops) + 50;
  const polys: Path[] = [];
  let k = 0;
  while (k < lv.length) {
    if (depthAt(k) <= 0) {
      k++;
      continue;
    }
    const k0 = k;
    while (k + 1 < lv.length && depthAt(k + 1) > 0) k++;
    const k1 = k;
    const ua = k0 > 0 ? (us[k0 - 1] + us[k0]) / 2 : us[k0] - 1;
    const ub = k1 < lv.length - 1 ? (us[k1] + us[k1 + 1]) / 2 : us[k1] + 1;
    const ta = topAt(outline, ua) ?? tops[k0];
    const tb = topAt(outline, ub) ?? tops[k1];
    const lower: Path = [[ua, ta - depthAt(k0)]];
    for (let q = k0; q <= k1; q++) {
      if (q > k0 && lv[q] !== lv[q - 1]) {
        // crisp riser between depth steps
        const um = (us[q - 1] + us[q]) / 2;
        const tm = topAt(outline, um) ?? tops[q];
        lower.push([um, tm - depthAt(q - 1)], [um, tm - depthAt(q)]);
      }
      lower.push([us[q], tops[q] - depthAt(q)]);
    }
    lower.push([ub, tb - depthAt(k1)]);
    polys.push([...lower, [ub, ceiling], [ua, ceiling]]);
    k++;
  }
  return polys.length ? simplifyShape(union(polys), 0.02) : [];
}

interface Cavity {
  cavity: Shape;
  swept: Shape;
  /** The swept insert outside the cavity: anything of the plate in here collides. */
  sweptOutside: Shape;
  bevel: number;
}

/**
 * The insert cavity through one plate, from sections across its thickness.
 * It only depends on the insert and the plate's plane, so it is cached on the
 * insert mesh and survives edits to everything else (strata, image, edges...).
 */
function insertCavity(insert: IndexedMesh, plane: Plane, t: number, cavityMode: unknown, clearance: number): Cavity | null {
  const key = [...plane.origin, ...plane.normal, ...plane.u, ...plane.v, t, cavityMode, clearance].join(',');
  return cached(insert, key, () => {
    const offs = [-t / 2, -t / 4, 0, t / 4, t / 2];
    const secs = offs.map((d) => sectionShape(insert, offsetPlane(plane, d)));
    if (!secs.some((s) => s.length)) return null;
    const [frontS, , mid, , back] = secs;
    const swept = unionShapes(...secs);
    let chosen: Shape;
    if (cavityMode === 'smaller') chosen = intersection(frontS, back);
    else if (cavityMode === 'mid') chosen = mid;
    else chosen = unionShapes(frontS, mid, back);
    const cavity = offset(chosen, clearance);
    const per = (shapePerimeter(frontS) + shapePerimeter(back)) / 2;
    const bevel = per > 0 ? shapeArea(xor(frontS, back)) / per : 0;
    return { cavity, swept, sweptOutside: difference(swept, cavity), bevel };
  });
}

/** Chord tolerance for smoothing offsets: well inside the DXF arc tolerance, far fewer points. */
const SMOOTH_TOL = 0.03;

/**
 * Round the image-driven cut region itself (closing + opening of radius r),
 * then cut it out. Only the cut's own edges change (step edges, recess floors,
 * pixel stair-steps); the plate's outer edges are never touched.
 */
function smoothImageCuts(plate: Shape, cut: Shape, r: number): Shape {
  if (!(r > 0.05)) return difference(plate, cut);
  const rounded = offset(offset(offset(unionShapes(cut), r, 'round', SMOOTH_TOL), -2 * r, 'round', SMOOTH_TOL), r, 'round', SMOOTH_TOL);
  return simplifyShape(difference(plate, rounded), SMOOTH_TOL / 2);
}

/**
 * Round every corner of the material (closing + opening of radius r). Where two
 * rounded bumps meet, the opening leaves a needle-thin inside cusp; a final
 * 0.3 mm closing blunts it so no gap is narrower than the kerf.
 */
export function roundAll(shape: Shape, r: number): Shape {
  if (!(r > 0.05) || !shape.length) return shape;
  const opened = offset(offset(offset(simplifyShape(shape, SMOOTH_TOL / 2), r, 'round', SMOOTH_TOL), -2 * r, 'round', SMOOTH_TOL), r, 'round', SMOOTH_TOL);
  const c = Math.min(0.3, r / 2);
  return simplifyShape(offset(offset(opened, c, 'round', SMOOTH_TOL), -c, 'round', SMOOTH_TOL), SMOOTH_TOL / 2);
}

function distToBoundary(p: Vec2, ex: ExPoly): number {
  let best = Infinity;
  for (const path of [ex.outer, ...ex.holes]) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[j], b = path[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function placeLabel(text: string, piece: ExPoly, prefer: Vec2, hMax: number): { paths: Path[]; at: Vec2 } | null {
  const shape = [piece];
  const bb = bboxOf([piece.outer]);
  for (const h of [hMax, hMax * 0.7, hMax * 0.5]) {
    const w = textWidth(text, h);
    if (w > bb.maxX - bb.minX - 2) continue;
    // the label box must sit inside material with 1 mm to spare
    const fits = (cx: number, cy: number) => {
      const pts: Vec2[] = [
        [cx, cy],
        [cx - w / 2, cy - h / 2],
        [cx + w / 2, cy - h / 2],
        [cx + w / 2, cy + h / 2],
        [cx - w / 2, cy + h / 2],
        [cx, cy - h / 2],
        [cx, cy + h / 2],
      ];
      if (!pts.every((p) => pointInShape(p, shape))) return false;
      // nothing of the boundary may cross the box (holes inside it, notches)
      for (const path of [piece.outer, ...piece.holes])
        for (const q of path) if (q[0] > cx - w / 2 - 1 && q[0] < cx + w / 2 + 1 && q[1] > cy - h / 2 - 1 && q[1] < cy + h / 2 + 1) return false;
      return pts.every((p) => distToBoundary(p, piece) >= 1);
    };
    if (fits(prefer[0], prefer[1])) return { paths: strokeTextCentered(text, prefer[0], prefer[1], h), at: prefer };
    const step = Math.max(h, (bb.maxX - bb.minX) / 24, (bb.maxY - bb.minY) / 24);
    const cands: Vec2[] = [];
    for (let y = bb.minY + h; y <= bb.maxY - h; y += step) for (let x = bb.minX + w / 2 + 1; x <= bb.maxX - w / 2 - 1; x += step) cands.push([x, y]);
    cands.sort((a, b) => Math.hypot(a[0] - prefer[0], a[1] - prefer[1]) - Math.hypot(b[0] - prefer[0], b[1] - prefer[1]));
    for (const c of cands) if (fits(c[0], c[1])) return { paths: strokeTextCentered(text, c[0], c[1], h), at: c };
  }
  return null;
}

export function partLabel(v: Values, family: Family, index: number, count: number): string {
  const prefix = String(v.partPrefix || 'S').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'S';
  const digits = Math.max(2, String(count).length);
  const num = String(index + 1).padStart(digits, '0');
  return family === 'P' ? `${prefix}-${num}` : `${prefix}${family}-${num}`;
}

export function slice(input: SliceInput): SliceResult {
  const { v, hf } = input;
  const warnings: string[] = [];
  const defs = plateDefs(v);
  const t = v.thickness;
  const e = embedOf(v);
  const useForm = v.stackSource === 'form';
  if (useForm && !input.source) warnings.push('Source form is missing (import a mesh or pick a shape).');

  // 1. outlines
  const outlines = defs.map((d) => {
    if (useForm) return input.source ? formOutline(d, input.source, v) : [];
    return hf ? strataOutline(d, hf, v) : [];
  });

  // 1b. tenons down into the embedded support ring
  const support = supportSpec(v, baseTop(v));
  const tenons = defs.map((d, di) => {
    if (!support) return { plane: d.plane, spans: [] as [number, number][] };
    const r = addTenons(outlines[di], d.plane, support, v, e);
    outlines[di] = r.outline;
    return { plane: d.plane, spans: r.spans };
  });

  // 2. waffle slots (computed from the shared intersection line, so both halves agree)
  const slots: Shape[] = defs.map(() => []);
  if (v.sliceMode === 'waffle') {
    const sw = t + v.slotClearance;
    defs.forEach((p, pi) => {
      if (p.family !== 'P') return;
      defs.forEach((x, xi) => {
        if (x.family !== 'X') return;
        // world point on both planes at base top
        const po = p.plane.origin, xo = x.plane.origin;
        const W: V3 = [po[0] + xo[0], po[1], po[2] + xo[2]];
        const uP = (W[0] - po[0]) * p.plane.u[0] + (W[2] - po[2]) * p.plane.u[2];
        const uX = (W[0] - xo[0]) * x.plane.u[0] + (W[2] - xo[2]) * x.plane.u[2];
        if (uP < p.u0 || uP > p.u1 || uX < x.u0 || uX > x.u1) return;
        const colP = intersection(outlines[pi], rect(uP - sw / 2, -BIG, uP + sw / 2, BIG));
        const colX = intersection(outlines[xi], rect(uX - sw / 2, -BIG, uX + sw / 2, BIG));
        if (!colP.length || !colX.length) return;
        const top = Math.min(shapeBBox(colP).maxY, shapeBBox(colX).maxY);
        const half = top / 2;
        slots[pi].push(...rect(uP - sw / 2, half, uP + sw / 2, BIG));
        slots[xi].push(...rect(uX - sw / 2, -BIG, uX + sw / 2, half));
      });
    });
  }

  const front = frontContext(v, input.front, defs, hf);
  const topWin = input.top && v.imgTopMode !== 'off' ? topWindow(v, input.top, defs) : null;
  const topField = topWin && input.top ? topProfileField(v, input.top, topWin) : null;
  // datum for flat impression floors: the lowest plate top inside the image window
  let topDatum = Infinity;
  if (topWin)
    defs.forEach((d, di) => {
      for (let u = d.u0; u <= d.u1; u += 2) {
        const p = planeToWorld(d.plane, u, 0);
        if (!topUV(topWin, p)) continue;
        const t = topAt(outlines[di], u);
        if (t !== null && t > 0) topDatum = Math.min(topDatum, t);
      }
    });
  const plates: PlateInfo[] = [];
  const allParts: Part[] = [];
  const insertOn = input.insert && v.insShape !== 'none';

  defs.forEach((def, di) => {
    let shape = outlines[di];
    const info: PlateInfo = { def, parts: [], bevel: 0, collision: 0, collisionAt: null, islands: 0, cavity: [], sweptInsert: [], tenons: tenons[di].spans.length };
    if (!shape.length) {
      plates.push(info);
      return;
    }

    // everything removed from the plate is collected and subtracted in one boolean;
    // image-driven cuts go first so their edges can be smoothed on their own
    const cuts: Shape[] = [];
    const imageCuts: Shape[] = [];

    // 3. insert cavity, per plate, in 2D
    if (insertOn) {
      const cav = insertCavity(input.insert!, def.plane, t, v.cavityMode, v.clearance);
      if (cav) {
        const { cavity, swept } = cav;
        info.cavity = cavity;
        info.sweptInsert = swept;
        info.bevel = cav.bevel;
        cuts.push(cavity);
        const hit = intersection(cav.sweptOutside, difference(shape, cavity));
        const hitArea = shapeArea(hit);
        if (hitArea > 0.05) {
          info.collision = hitArea;
          const bb = shapeBBox(hit);
          info.collisionAt = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
        }
      }
    }

    // 4. image-driven front cut-outs
    let etch: Path[] = [];
    if (front) {
      if (v.imgFrontMode !== 'off') {
        const cut = frontCut(def, outlines[di], v, front);
        if (cut.length) imageCuts.push(cut);
      }
      etch = frontEtch(def, v, front);
    }

    // 4b. image impression into the top surface
    if (topWin && input.top) {
      const carve = topCarve(def, outlines[di], v, topField!, topWin, Number.isFinite(topDatum) ? topDatum : 0);
      if (carve.length) imageCuts.push(carve);
    }
    if (imageCuts.length) shape = smoothImageCuts(shape, imageCuts.flat(), v.cutSmooth);
    // all-edges rounding happens before the functional cuts below, so they stay crisp
    shape = roundAll(shape, v.edgeRound);

    // 5. anchor holes in the embedded tab
    if (e > 0 && v.embedMode === 'cast' && v.anchorHoles > 0 && e > v.anchorDia + 2 * v.minFeature) {
      const tr = tabRange(outlines[di], e);
      if (tr) {
        const holes: Path[] = [];
        const k = v.anchorHoles;
        for (let j = 0; j < k; j++) {
          const u = tr[0] + ((j + 1) * (tr[1] - tr[0])) / (k + 1);
          holes.push(circlePath(u, -e / 2, v.anchorDia / 2));
        }
        cuts.push(holes.map((h) => ({ outer: h, holes: [] })));
      }
    }

    // 6. waffle slots
    if (slots[di].length) cuts.push(slots[di]);
    if (cuts.length) shape = difference(shape, cuts.flat());

    // 7. split into physical pieces; islands inside holes would fall out
    const pieces: ExPoly[] = [];
    for (const ex of shape) {
      if ((ex.depth ?? 0) > 0) {
        info.islands++;
        continue;
      }
      if (shapeArea([ex]) < 0.5) continue;
      pieces.push(ex);
    }
    pieces.sort((a, b) => {
      const ba = bboxOf([a.outer]), bb = bboxOf([b.outer]);
      return ba.minX + ba.maxX - (bb.minX + bb.maxX);
    });

    const base = partLabel(v, def.family, def.index, def.count);
    pieces.forEach((ex, pi) => {
      const id = pieces.length > 1 ? `${base}${String.fromCharCode(97 + (pi % 26))}` : base;
      const bb = bboxOf([ex.outer]);
      const hLab = Math.min(v.labelHeight, e > 0 ? e * 0.5 : v.labelHeight);
      const prefer: Vec2 = [(bb.minX + bb.maxX) / 2, e > 0 && bb.minY < -e / 2 ? -e / 2 : bb.minY + hLab];
      const lab = placeLabel(id, ex, prefer, hLab);
      const pieceEtch = etch.length ? clipLines(etch, offset([ex], -0.8)) : [];
      const part: Part = {
        id,
        plateKey: def.key,
        family: def.family,
        index: def.index,
        piece: pi,
        plane: def.plane,
        thickness: t,
        shape: [ex],
        etch: pieceEtch,
        labelPaths: lab?.paths ?? [],
        labelAt: lab?.at ?? null,
        area: shapeArea([ex]),
        perimeter: shapePerimeter([ex]),
        bbox: bb,
        anchored: e <= 0 || bb.minY < -0.5,
        kind: 'plate',
      };
      info.parts.push(part);
      allParts.push(part);
    });
    plates.push(info);
  });

  // 8. the support ring, cut from the same sheet, with a mortise for every tenon
  if (support) {
    const ring = ringShape(support, v, tenons);
    const pieces = ring.filter((ex) => (ex.depth ?? 0) === 0 && shapeArea([ex]) > 0.5);
    if (pieces.length > 1) warnings.push(`Support ring falls apart into ${pieces.length} pieces: widen it or raise the slot end land.`);
    const plane = supportPlane(support);
    const base = partLabel(v, 'S', 0, 1);
    const hLab = Math.min(v.labelHeight, (support.outer - support.inner) * 0.4);
    pieces.forEach((ex, pi) => {
      const id = pieces.length > 1 ? `${base}${String.fromCharCode(97 + (pi % 26))}` : base;
      const bb = bboxOf([ex.outer]);
      const lab = placeLabel(id, ex, [0, (support.inner + support.outer) / 2], hLab);
      const part: Part = {
        id,
        plateKey: 'S0',
        family: 'S',
        index: 0,
        piece: pi,
        plane,
        thickness: support.thickness,
        shape: [ex],
        etch: [],
        labelPaths: lab?.paths ?? [],
        labelAt: lab?.at ?? null,
        area: shapeArea([ex]),
        perimeter: shapePerimeter([ex]),
        bbox: bb,
        anchored: true,
        kind: 'plate',
      };
      allParts.push(part);
    });
  }

  return { plates, parts: allParts, warnings, front: front ? front.win : null, top: topWin, support };
}
