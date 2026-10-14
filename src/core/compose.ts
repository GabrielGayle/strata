// Image composer: several image blocks per surface, placed freely, blended
// down to the same brightness grid a single uploaded image becomes. The
// pipeline still sees one greyscale image per surface, so every image mode
// works on a composition unchanged. Pure, so it can run (and be tested) anywhere.
import type { Gray } from './image';
import type { PatternSpec } from './pattern';

export type Surface = 'top' | 'front' | 'side';
export const SURFACES: Surface[] = ['top', 'front', 'side'];

/** How a block combines with what is under it. Dark = cut deepest. */
export type BlendMode = 'darken' | 'multiply' | 'lighten' | 'normal';

export interface Stroke {
  /** x, y pairs as fractions of the pad (y = 0 at the top). */
  pts: number[];
  /** Brush diameter as a fraction of the pad height. */
  size: number;
  /** Brightness the brush paints: 0 = black (cut deepest), 1 = white (erase). */
  tone: number;
  /** 0 = hard edge … 1 = fully feathered. */
  soft: number;
}

export interface DrawingSpec {
  kind: 'drawing';
  /** Width / height of the pad. */
  aspect: number;
  background: number;
  strokes: Stroke[];
}

export type BlockSource =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'pattern'; spec: PatternSpec }
  | { kind: 'drawing'; spec: DrawingSpec };

export interface Block {
  id: string;
  name: string;
  /** Which surface the block is pressed into; null = parked in the tray. */
  surface: Surface | null;
  source: BlockSource;
  /** Centre as fractions of the frame (y = 0 at the top). */
  x: number;
  y: number;
  /** Block width as a fraction of the frame width; height follows the source's proportions. */
  scale: number;
  /** Degrees, clockwise. */
  rotate: number;
  opacity: number;
  blend: BlendMode;
  invert: boolean;
  /** 1 = as is; higher pushes greys towards black and white. */
  contrast: number;
  hidden: boolean;
  /** Position in the node view. */
  node?: { x: number; y: number };
}

export interface Frame {
  /** Width / height of the surface's image. */
  aspect: number;
  /** Brightness where no block covers: 1 = untouched plate. */
  background: number;
}

export interface Composition {
  kind: 'composition';
  frames: Record<Surface, Frame>;
  /** Bottom to top. */
  blocks: Block[];
}

export function newComposition(aspects: Partial<Record<Surface, number>> = {}): Composition {
  const f = (s: Surface): Frame => ({ aspect: aspects[s] ?? 1.5, background: 1 });
  return { kind: 'composition', frames: { top: f('top'), front: f('front'), side: f('side') }, blocks: [] };
}

let idn = 0;
export function blockId(): string {
  return `b${Date.now().toString(36)}${(idn++).toString(36)}`;
}

export function makeBlock(source: BlockSource, patch: Partial<Block> = {}): Block {
  const name = source.kind === 'image' ? source.name.replace(/\.[a-z0-9]+$/i, '') : source.kind === 'pattern' ? 'Pattern' : 'Drawing';
  return { id: blockId(), name, surface: 'top', source, x: 0.5, y: 0.5, scale: 0.6, rotate: 0, opacity: 1, blend: 'darken', invert: false, contrast: 1, hidden: false, ...patch };
}

export function newDrawing(aspect = 1): DrawingSpec {
  return { kind: 'drawing', aspect, background: 1, strokes: [] };
}

/** Rasterise a drawing: each stroke is a chain of round-capped segments painted over the ones before. */
export function renderDrawing(spec: DrawingSpec, w: number, h: number): Gray {
  const data = new Float32Array(w * h).fill(spec.background);
  for (const s of spec.strokes) {
    const r = Math.max(0.5, (s.size * h) / 2);
    const feather = Math.max(0.75, r * Math.min(1, Math.max(0, s.soft)));
    const P: number[] = [];
    for (let i = 0; i < s.pts.length; i += 2) P.push(s.pts[i] * w, s.pts[i + 1] * h);
    if (P.length === 2) P.push(P[0], P[1]); // a dab
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 2) {
      x0 = Math.min(x0, P[i]);
      x1 = Math.max(x1, P[i]);
      y0 = Math.min(y0, P[i + 1]);
      y1 = Math.max(y1, P[i + 1]);
    }
    const pad = r + 1;
    const ya = Math.max(0, Math.floor(y0 - pad)), yb = Math.min(h - 1, Math.ceil(y1 + pad));
    const xa = Math.max(0, Math.floor(x0 - pad)), xb = Math.min(w - 1, Math.ceil(x1 + pad));
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const px = x + 0.5, py = y + 0.5;
        let d = Infinity;
        for (let i = 0; i + 3 < P.length; i += 2) d = Math.min(d, segDist(px, py, P[i], P[i + 1], P[i + 2], P[i + 3]));
        // coverage: 1 inside r - feather, fading to 0 at r
        const a = Math.min(1, Math.max(0, (r - d) / feather));
        if (a <= 0) continue;
        const k = y * w + x;
        data[k] += (s.tone - data[k]) * a;
      }
  }
  return { w, h, data };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/** Size of a block in frame fractions: width = scale, height follows the source's proportions. */
export function blockSize(b: Block, src: { w: number; h: number }, frameAspect: number): { w: number; h: number } {
  return { w: b.scale, h: (b.scale * frameAspect * src.h) / src.w };
}

function bilinear(g: Gray, u: number, v: number): number {
  const x = Math.min(g.w - 1, Math.max(0, u * g.w - 0.5));
  const y = Math.min(g.h - 1, Math.max(0, v * g.h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = g.data[y0 * g.w + x0], b = g.data[y0 * g.w + x1];
  const c = g.data[y1 * g.w + x0], d = g.data[y1 * g.w + x1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * Blend a surface's visible blocks, bottom to top, into one brightness grid.
 * `sourceOf` gives each block's decoded brightness grid (null while loading: skipped).
 */
export function composite(comp: Composition, surface: Surface, sourceOf: (b: Block) => Gray | null, w: number, h: number): Gray {
  const frame = comp.frames[surface];
  const out = new Float32Array(w * h).fill(frame.background);
  for (const b of comp.blocks) {
    if (b.surface !== surface || b.hidden || b.opacity <= 0) continue;
    const src = sourceOf(b);
    if (!src) continue;
    const size = blockSize(b, src, frame.aspect);
    // work in pixels so rotation keeps right angles on a non-square frame
    const bw = size.w * w, bh = size.h * h;
    const cx = b.x * w, cy = b.y * h;
    const th = (b.rotate * Math.PI) / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    const ex = (Math.abs(cos) * bw + Math.abs(sin) * bh) / 2;
    const ey = (Math.abs(sin) * bw + Math.abs(cos) * bh) / 2;
    const ya = Math.max(0, Math.floor(cy - ey)), yb = Math.min(h - 1, Math.ceil(cy + ey));
    const xa = Math.max(0, Math.floor(cx - ex)), xb = Math.min(w - 1, Math.ceil(cx + ex));
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        // into the block's own axes (inverse rotation)
        const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
        const u = lx / bw + 0.5, v = ly / bh + 0.5;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        let s = bilinear(src, u, v);
        if (b.invert) s = 1 - s;
        s = Math.min(1, Math.max(0, (s - 0.5) * b.contrast + 0.5));
        const k = y * w + x;
        const o = out[k];
        const t = b.blend === 'darken' ? Math.min(o, s) : b.blend === 'lighten' ? Math.max(o, s) : b.blend === 'multiply' ? o * s : s;
        out[k] = o + (t - o) * b.opacity;
      }
  }
  return { w, h, data: out };
}

/** Pixel size for a frame whose longer side is `long`. */
export function frameSize(frame: Frame, long: number): { w: number; h: number } {
  const a = Math.max(0.1, frame.aspect);
  return a >= 1 ? { w: long, h: Math.max(2, Math.round(long / a)) } : { w: Math.max(2, Math.round(long * a)), h: long };
}

/** Surfaces that have at least one block on them. */
export function usedSurfaces(comp: Composition): Surface[] {
  return SURFACES.filter((s) => comp.blocks.some((b) => b.surface === s));
}

/** Move a block to another surface, keeping its place on the frame. Moving to null parks it in the tray. */
export function moveBlock(comp: Composition, id: string, surface: Surface | null): Composition {
  const i = comp.blocks.findIndex((b) => b.id === id);
  if (i < 0) return comp;
  const b = { ...comp.blocks[i], surface };
  // land on top of whatever is already on the new surface
  const rest = comp.blocks.filter((_, j) => j !== i);
  return { ...comp, blocks: [...rest, b] };
}

/** Exchange everything on two surfaces. */
export function swapSurfaces(comp: Composition, a: Surface, c: Surface): Composition {
  const sw = (s: Surface | null) => (s === a ? c : s === c ? a : s);
  return { ...comp, frames: { ...comp.frames, [a]: comp.frames[c], [c]: comp.frames[a] }, blocks: comp.blocks.map((b) => ({ ...b, surface: sw(b.surface) })) };
}

/** Restack a block among the blocks on its own surface. */
export function restack(comp: Composition, id: string, dir: 1 | -1): Composition {
  const b = comp.blocks.find((x) => x.id === id);
  if (!b) return comp;
  const same = comp.blocks.map((x, i) => ({ x, i })).filter(({ x }) => x.surface === b.surface);
  const k = same.findIndex(({ x }) => x.id === id);
  const n = same[k + dir];
  if (!n) return comp;
  const blocks = comp.blocks.slice();
  blocks[same[k].i] = n.x;
  blocks[n.i] = b;
  return { ...comp, blocks };
}
