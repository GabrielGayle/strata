// Impress image: pictures pressed into the top surface or the front face, placed
// by hand in the 3D view. A placement is an ordinary composer layer (Block) on that
// surface, so the slicer, build pack, price and saved projects see nothing new:
// the surface's composite is the top impression / front cut-out image it always was.
// Here: where each surface is in the world, frame <-> world maps, per-layer depth,
// and the depth field the x-ray view draws. Pure, so it runs (and is tested) anywhere.
import type { Values } from './params';
import type { Block, Composition, Surface } from './compose';
import type { Gray } from './image';
import type { Plane, V3 } from './section';
import { topProfileField, type FrontWindow, type SliceResult, type TopWindow } from './slicer';

export type ImpressSurface = Extract<Surface, 'top' | 'front'>;
export const IMPRESS_SURFACES: ImpressSurface[] = ['top', 'front'];

/** A picture rectangle on a surface: frame fractions (x right, y down, 0..1) map onto it. */
export interface ImpressFrame {
  surface: ImpressSurface;
  /** World point under the picture's top-left corner. */
  origin: V3;
  /** Unit vectors along the picture's x (left to right) and y (top to bottom). */
  ax: V3;
  ay: V3;
  /** Picture size on the surface, mm. */
  w: number;
  h: number;
  /** Unit vector into the material. */
  inward: V3;
}

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A top window (as the slicer fits it, quarter turns included) at height y. */
export function topFrame(win: TopWindow, y: number): ImpressFrame {
  const R: V3 = [win.right[0], 0, win.right[1]];
  const S: V3 = [win.stack[0], 0, win.stack[1]];
  const at = (r: number, s: number): V3 => [r * R[0] + s * S[0], y, r * R[2] + s * S[2]];
  const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
  const W = win.r1 - win.r0, H = win.s1 - win.s0;
  // the inverse of topUV: picture right / down for each quarter turn
  switch (win.turns) {
    case 1:
      return { surface: 'top', origin: at(win.r1, win.s1), ax: neg(S), ay: neg(R), w: H, h: W, inward: [0, -1, 0] };
    case 2:
      return { surface: 'top', origin: at(win.r1, win.s0), ax: neg(R), ay: S, w: W, h: H, inward: [0, -1, 0] };
    case 3:
      return { surface: 'top', origin: at(win.r0, win.s0), ax: S, ay: R, w: H, h: W, inward: [0, -1, 0] };
    default:
      return { surface: 'top', origin: at(win.r0, win.s1), ax: R, ay: neg(S), w: W, h: H, inward: [0, -1, 0] };
  }
}

/** A front window (front plate coords) on the plate's outer face. Looking at the front, picture right is -u. */
export function frontFrame(win: FrontWindow, plane: Plane, inward: V3, halfThick: number): ImpressFrame {
  const ax: V3 = [-plane.u[0], -plane.u[1], -plane.u[2]];
  const ay: V3 = [-plane.v[0], -plane.v[1], -plane.v[2]];
  const corner = add(add(plane.origin, plane.u, win.u1), plane.v, win.v1);
  return { surface: 'front', origin: add(corner, inward, -halfThick), ax, ay, w: win.u1 - win.u0, h: win.v1 - win.v0, inward };
}

export interface SurfaceFrames {
  /** The whole surface a picture can cover. */
  area: ImpressFrame;
  /** Where the surface's current picture sits (null when it has none). */
  window: ImpressFrame | null;
}

/** Where each surface is, from a built model. `lift` raises plates sitting in a sunken frame. */
export function impressFrames(sliced: SliceResult, v: Values, lift = 0): Record<ImpressSurface, SurfaceFrames | null> {
  const areas = sliced.areas;
  const plates = sliced.plates.filter((p) => p.def.family === 'P').sort((a, b) => a.def.index - b.def.index);
  // the highest plate top under the picture, so the frame floats just above the surface
  let topY = areas?.topDatum ?? null;
  if (topY === null) for (const p of sliced.parts) topY = Math.max(topY ?? -Infinity, p.bbox.maxY);
  const y = (topY ?? v.stackHeight) + lift + 0.4;
  // Image direction turns every picture before it is read: map the picture as it was drawn
  const r = ((Math.round(Number(v.imgRotate) / 90) % 4) + 4) % 4;
  const un = (f: ImpressFrame) => unrotateFrame(f, r);
  const top = areas?.top ? { area: un(topFrame(areas.top, y)), window: sliced.top ? un(topFrame(sliced.top, y)) : null } : null;
  let front: SurfaceFrames | null = null;
  const p0 = plates[0];
  if (areas?.front && p0) {
    const plane = p0.def.home ?? p0.def.plane;
    const lifted: Plane = { ...plane, origin: [plane.origin[0], plane.origin[1] + lift, plane.origin[2]] };
    const p1 = plates[1];
    // into the stack: towards the next plate (one plate alone: along its normal)
    let inward = unit(plane.normal);
    if (p1) {
      const d = sub((p1.def.home ?? p1.def.plane).origin, plane.origin);
      if (dot(d, inward) < 0) inward = [-inward[0], -inward[1], -inward[2]];
    }
    const half = v.thickness / 2 + 0.4;
    front = { area: un(frontFrame(areas.front, lifted, inward, half)), window: sliced.front ? un(frontFrame(sliced.front, lifted, inward, half)) : null };
  }
  return { top, front };
}

/**
 * The frame of a picture before it was turned `r` quarter turns clockwise (Image
 * direction), given the frame the turned picture fills.
 */
export function unrotateFrame(f: ImpressFrame, r: number): ImpressFrame {
  const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
  switch (((r % 4) + 4) % 4) {
    case 1:
      return { ...f, origin: add(f.origin, f.ax, f.w), ax: f.ay, ay: neg(f.ax), w: f.h, h: f.w };
    case 2:
      return { ...f, origin: add(add(f.origin, f.ax, f.w), f.ay, f.h), ax: neg(f.ax), ay: neg(f.ay) };
    case 3:
      return { ...f, origin: add(f.origin, f.ay, f.h), ax: neg(f.ay), ay: f.ax, w: f.h, h: f.w };
    default:
      return f;
  }
}

/** World point of frame fractions (fx right, fy down), `depth` mm into the material. */
export function framePoint(f: ImpressFrame, fx: number, fy: number, depth = 0): V3 {
  return add(add(add(f.origin, f.ax, fx * f.w), f.ay, fy * f.h), f.inward, depth);
}

/** Frame fractions of a world point (the point is projected onto the frame's plane). */
export function frameFractions(f: ImpressFrame, p: V3): [number, number] {
  const d = sub(p, f.origin);
  return [dot(d, f.ax) / f.w, dot(d, f.ay) / f.h];
}

/** Width / height of a frame. */
export const frameAspect = (f: ImpressFrame) => f.w / Math.max(1e-6, f.h);

/** A layer's rectangle on the frame, in mm about the frame's top-left: centre, half sizes, turn (radians, clockwise). */
export function blockRect(b: Block, src: { w: number; h: number }, f: ImpressFrame) {
  const w = b.scale * f.w;
  const h = (w * src.h) / src.w;
  return { cx: b.x * f.w, cy: b.y * f.h, hw: w / 2, hh: h / 2, th: (b.rotate * Math.PI) / 180 };
}

/** The four corners of a layer, in frame fractions, clockwise from top-left. */
export function blockCorners(b: Block, src: { w: number; h: number }, f: ImpressFrame): [number, number][] {
  const r = blockRect(b, src, f);
  const c = Math.cos(r.th), s = Math.sin(r.th);
  return [
    [-r.hw, -r.hh],
    [r.hw, -r.hh],
    [r.hw, r.hh],
    [-r.hw, r.hh],
  ].map(([x, y]) => [(r.cx + x * c - y * s) / f.w, (r.cy + x * s + y * c) / f.h]);
}

/** The topmost visible layer of a surface under frame fractions, or null. */
export function blockAt(comp: Composition, surface: ImpressSurface, fx: number, fy: number, dimsOf: (b: Block) => { w: number; h: number } | null, f: ImpressFrame): Block | null {
  for (let i = comp.blocks.length - 1; i >= 0; i--) {
    const b = comp.blocks[i];
    if (b.surface !== surface || b.hidden) continue;
    const src = dimsOf(b);
    if (!src) continue;
    const r = blockRect(b, src, f);
    const dx = fx * f.w - r.cx, dy = fy * f.h - r.cy;
    const c = Math.cos(r.th), s = Math.sin(r.th);
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    if (Math.abs(lx) <= r.hw && Math.abs(ly) <= r.hh) return b;
  }
  return null;
}

/**
 * Carry a surface's layers from one frame to another without moving them on the
 * plates: same centre, same size in mm, same direction. Used when the frame is
 * widened to the whole surface, so placing by hand maps one-to-one.
 */
export function refitBlocks(comp: Composition, surface: ImpressSurface, from: ImpressFrame, to: ImpressFrame): Composition {
  const turn = (Math.atan2(dot(from.ax, to.ay), dot(from.ax, to.ax)) * 180) / Math.PI;
  const blocks = comp.blocks.map((b) => {
    if (b.surface !== surface) return b;
    const [x, y] = frameFractions(to, framePoint(from, b.x, b.y));
    return { ...b, x: round(x), y: round(y), scale: round((b.scale * from.w) / to.w), rotate: Math.round((((b.rotate + turn) % 360) + 540) % 360) - 180 };
  });
  return { ...comp, blocks, frames: { ...comp.frames, [surface]: { ...comp.frames[surface], aspect: frameAspect(to) } } };
}

const round = (x: number) => Math.round(x * 1e5) / 1e5;

/** Params that make a surface's picture fill the whole surface, upright, so the frame is the area. */
export function fillPatch(surface: ImpressSurface, v: Values): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (surface === 'top') {
    if (v.topScale !== 1) out.topScale = 1;
    if (v.topX) out.topX = 0;
    if (v.topZ) out.topZ = 0;
    if (String(v.topRotate) !== '0') out.topRotate = '0';
  }
  return out;
}

/** Params that switch a surface's impression on (kept as they are when already on). */
export function enablePatch(surface: ImpressSurface, v: Values): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!v.imageOn) out.imageOn = true;
  if (surface === 'top' && v.imgTopMode === 'off') out.imgTopMode = 'carve';
  if (surface === 'front' && v.imgFrontMode === 'off') out.imgFrontMode = 'layers';
  return out;
}

/** The deepest a surface's darkest picture cuts, mm. */
export function maxDepth(surface: ImpressSurface, v: Values): number {
  if (surface === 'top') return v.topDepth;
  return frontPlates(v) * v.pitch;
}

/** Front: how many plates the darkest picture cuts through. */
export function frontPlates(v: Values): number {
  return Math.max(0, Math.round(v.frontDepth * Math.min(1, Math.max(0, v.imgFrontStrength))));
}

/** The largest depth the depth slider offers on a surface, mm. */
export function depthCap(surface: ImpressSurface, v: Values, plateCount: number): number {
  if (surface === 'top') return Math.max(5, Math.min(300, Math.round(v.stackHeight * 0.8)));
  return Math.max(1, plateCount) * v.pitch;
}

/** Params for a surface whose darkest picture cuts `mm` deep. Front rounds to whole plates. */
export function depthPatch(surface: ImpressSurface, v: Values, mm: number): Record<string, number> {
  if (surface === 'top') return { topDepth: Math.max(1, Math.round(mm * 10) / 10) };
  return { frontDepth: Math.max(1, Math.round(mm / v.pitch)), imgFrontStrength: 1 };
}

/** How deep one layer cuts: its strength (opacity) times the surface's deepest cut. */
export function layerDepth(b: Block, surface: ImpressSurface, v: Values): number {
  return b.opacity * maxDepth(surface, v);
}

/**
 * Set one layer's depth. Layers share the surface's deepest cut and each one's
 * strength is a share of it, so a layer set deeper than the rest raises the
 * surface's depth and scales the others' shares down to keep their own depth.
 */
export function setLayerDepth(comp: Composition, surface: ImpressSurface, id: string, mm: number, v: Values): { comp: Composition; patch: Record<string, number> } {
  const cur = maxDepth(surface, v);
  mm = Math.max(0, mm);
  if (mm <= cur + 1e-6 && cur > 0) {
    const blocks = comp.blocks.map((b) => (b.id === id ? { ...b, opacity: round(mm / cur) } : b));
    return { comp: { ...comp, blocks }, patch: {} };
  }
  const patch = depthPatch(surface, v, mm);
  const next = maxDepth(surface, { ...v, ...patch } as Values);
  const blocks = comp.blocks.map((b) => {
    if (b.id === id) return { ...b, opacity: round(Math.min(1, mm / next)) };
    if (b.surface !== surface) return b;
    return { ...b, opacity: round(Math.min(1, (b.opacity * cur) / next)) };
  });
  return { comp: { ...comp, blocks }, patch };
}

/**
 * Depth in mm at each pixel of a surface's composite: what the slicer cuts there.
 * Top: the impression profile (tone, pillow… with steps), down from the surface.
 * Front: whole plates cut through, as many as the darkness reaches.
 */
export function depthField(surface: ImpressSurface, v: Values, img: Gray, f: ImpressFrame): Float32Array {
  const n = img.w * img.h;
  const out = new Float32Array(n);
  if (surface === 'top') {
    const win: TopWindow = { right: [1, 0], stack: [0, 1], r0: 0, r1: f.w, s0: 0, s1: f.h, turns: 0 };
    const field = topProfileField(v, img, win);
    const steps = Math.round(v.topSteps);
    for (let i = 0; i < n; i++) {
      let t = v.imgTopMode === 'raise' ? 1 - field.data[i] : field.data[i];
      if (steps > 0) t = Math.round(t * steps) / steps;
      out[i] = t * v.topDepth;
    }
    return out;
  }
  const N = Math.max(1, v.frontDepth);
  const s = v.imgFrontStrength;
  for (let i = 0; i < n; i++) {
    const dark = 1 - img.data[i];
    // plate k (from the front) is cut where dark * strength > (k + 0.5) / N
    const cut = Math.max(0, Math.min(N, Math.ceil(dark * s * N - 0.5)));
    out[i] = cut * v.pitch;
  }
  return out;
}

/** A height-field sheet for the x-ray view: the floor of the cut under the frame. */
export function reliefMesh(f: ImpressFrame, depth: Float32Array, w: number, h: number): { positions: Float32Array; depths: Float32Array; index: Uint32Array } {
  const positions = new Float32Array(w * h * 3);
  const depths = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const d = depth[k];
      const p = framePoint(f, (x + 0.5) / w, (y + 0.5) / h, d);
      positions.set(p, k * 3);
      depths[k] = d;
    }
  const idx: number[] = [];
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
      // only cells that cut something: an uncut surface stays clear
      if (depths[a] <= 0 && depths[b] <= 0 && depths[c] <= 0 && depths[d] <= 0) continue;
      idx.push(a, c, b, b, c, d);
    }
  return { positions, depths, index: Uint32Array.from(idx) };
}
