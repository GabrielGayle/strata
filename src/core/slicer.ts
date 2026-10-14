// The slicer: turns forms + parameters into flat, laser-ready plates.
// Every outline and every cavity is computed per plate in 2D, then extruded
// straight through the sheet, so every edge is cut at 90°.
import type { Values } from './params';
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
import { marchingSquares, sample, type Gray } from './image';
import { strokeTextCentered, textWidth } from './strokefont';

export type Family = 'P' | 'X' | 'R';

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
}

export interface SliceInput {
  v: Values;
  hf: HeightField | null;
  source: IndexedMesh | null;
  insert: IndexedMesh | null;
  front: Gray | null;
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
    const hx = Math.max(1, v.baseLength / 2 - v.sideMargin);
    const hz = Math.max(1, v.baseWidth / 2 - v.sideMargin);
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const R = Math.min(Math.abs(c) > 1e-9 ? hx / Math.abs(c) : Infinity, Math.abs(s) > 1e-9 ? hz / Math.abs(s) : Infinity);
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
  const e = embedOf(v);
  const inset = Math.max(0, Math.min(v.tabInset, (u1 - u0) / 2 - 5));
  const poly: Path = [];
  if (e > 0 && inset > 0) poly.push([u0 + inset, -e], [u1 - inset, -e], [u1 - inset, 0], [u1, 0]);
  else if (e > 0) poly.push([u0, -e], [u1, -e]);
  else poly.push([u0, 0], [u1, 0]);
  for (let k = top.length - 1; k >= 0; k--) poly.push(top[k]);
  if (e > 0 && inset > 0) poly.push([u0, 0], [u0 + inset, 0]);
  return union([poly]);
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
  const strength = v.imgFrontStrength;
  const frame = offset(outline, -v.frontMargin);
  let cut: Shape = [];
  if (v.imgFrontMode === 'layers') {
    const level = (def.index + 0.5) / v.frontDepth;
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
        if (2 * r >= minD) circles.push(circlePath(u, vv, r, Math.max(12, Math.min(32, Math.ceil(r * 3)))));
      }
    }
    if (!circles.length) return [];
    cut = union(circles);
  }
  return intersection(cut, frame);
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
  const plates: PlateInfo[] = [];
  const allParts: Part[] = [];
  const insertOn = input.insert && v.insShape !== 'none';

  defs.forEach((def, di) => {
    let shape = outlines[di];
    const info: PlateInfo = { def, parts: [], bevel: 0, collision: 0, collisionAt: null, islands: 0, cavity: [], sweptInsert: [] };
    if (!shape.length) {
      plates.push(info);
      return;
    }

    // everything removed from the plate is collected and subtracted in one boolean
    const cuts: Shape[] = [];

    // 3. insert cavity, per plate, in 2D
    if (insertOn) {
      const offs = [-t / 2, -t / 4, 0, t / 4, t / 2];
      const secs = offs.map((d) => sectionShape(input.insert!, offsetPlane(def.plane, d)));
      if (secs.some((s) => s.length)) {
        const [frontS, , mid, , back] = secs;
        const swept = unionShapes(...secs);
        let chosen: Shape;
        if (v.cavityMode === 'smaller') chosen = intersection(frontS, back);
        else if (v.cavityMode === 'mid') chosen = mid;
        else chosen = unionShapes(frontS, mid, back);
        const cavity = offset(chosen, v.clearance);
        info.cavity = cavity;
        info.sweptInsert = swept;
        const per = (shapePerimeter(frontS) + shapePerimeter(back)) / 2;
        info.bevel = per > 0 ? shapeArea(xor(frontS, back)) / per : 0;
        cuts.push(cavity);
        const hit = intersection(difference(swept, cavity), difference(shape, cavity));
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
        if (cut.length) cuts.push(cut);
      }
      etch = frontEtch(def, v, front);
    }

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

  return { plates, parts: allParts, warnings, front: front ? front.win : null };
}
