// Arranging the image layers on one surface: pin them to a corner or an edge,
// or lay them out in a row, a column or a grid. Also the live layer view of a
// project, where a surface holding one ordinary picture shows it as a single
// layer until something else is added. Pure, so it can be tested anywhere.
import { blockId, makeBlock, newComposition, SURFACES, type Block, type Composition, type Surface } from './compose';
import type { ImageAsset } from './project';

/** Pixel size of a block's source; only the proportions matter. */
export type DimsOf = (b: Block) => { w: number; h: number } | null;

/** Where a pin puts things: 0 = left / top, 0.5 = middle, 1 = right / bottom. */
export interface Anchor {
  id: string;
  ax: 0 | 0.5 | 1;
  ay: 0 | 0.5 | 1;
  label: string;
  glyph: string;
}

export const ANCHORS: Anchor[] = [
  { id: 'tl', ax: 0, ay: 0, label: 'Pin to top left', glyph: '↖' },
  { id: 't', ax: 0.5, ay: 0, label: 'Pin to top', glyph: '↑' },
  { id: 'tr', ax: 1, ay: 0, label: 'Pin to top right', glyph: '↗' },
  { id: 'l', ax: 0, ay: 0.5, label: 'Pin to left', glyph: '←' },
  { id: 'c', ax: 0.5, ay: 0.5, label: 'Centre', glyph: '·' },
  { id: 'r', ax: 1, ay: 0.5, label: 'Pin to right', glyph: '→' },
  { id: 'bl', ax: 0, ay: 1, label: 'Pin to bottom left', glyph: '↙' },
  { id: 'b', ax: 0.5, ay: 1, label: 'Pin to bottom', glyph: '↓' },
  { id: 'br', ax: 1, ay: 1, label: 'Pin to bottom right', glyph: '↘' },
];

export type LayoutKind = 'row' | 'column' | 'grid2' | 'grid3' | 'auto' | 'stack';

export const LAYOUTS: { id: LayoutKind; label: string; hint: string }[] = [
  { id: 'row', label: 'Row', hint: 'Side by side, left to right' },
  { id: 'column', label: 'Column', hint: 'One above the other' },
  { id: 'grid2', label: '2×2', hint: 'Two by two grid (adds rows when there are more than four)' },
  { id: 'grid3', label: '3×3', hint: 'Three by three grid (adds rows when there are more than nine)' },
  { id: 'auto', label: 'Auto grid', hint: 'As many rows and columns as suit the frame and the number of layers' },
  { id: 'stack', label: 'Stack', hint: 'All centred, each as large as the frame allows' },
];

/** Columns and rows a layout uses for n layers on a frame `frameAspect` wide to 1 high. */
export function layoutGrid(kind: LayoutKind, n: number, frameAspect = 1): { cols: number; rows: number } {
  const k = Math.max(1, n);
  if (kind === 'row') return { cols: k, rows: 1 };
  if (kind === 'column') return { cols: 1, rows: k };
  if (kind === 'stack') return { cols: 1, rows: 1 };
  // auto: cells as near square as the frame allows (a long thin frame gets one long line)
  const cols = kind === 'grid2' ? 2 : kind === 'grid3' ? 3 : Math.min(k, Math.max(1, Math.round(Math.sqrt(k * frameAspect))));
  const min = kind === 'grid2' ? 2 : kind === 'grid3' ? 3 : 1;
  return { cols, rows: Math.max(min, Math.ceil(k / cols)) };
}

/** Width and height a block covers on the frame, as fractions of it, turned as it is. */
export function blockExtent(b: Block, dims: { w: number; h: number } | null, frameAspect: number): { w: number; h: number } {
  const d = dims ?? { w: 1, h: 1 };
  // in units of the frame height, so turning keeps right angles on a wide frame
  const bw = b.scale * frameAspect;
  const bh = (b.scale * frameAspect * d.h) / d.w;
  const th = (b.rotate * Math.PI) / 180;
  const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  return { w: (c * bw + s * bh) / frameAspect, h: s * bw + c * bh };
}

/** Margin, in frame-height fractions, turned into fractions of each side. */
function margins(m: number, fa: number) {
  return { mx: m / fa, my: m };
}

function patchBlocks(comp: Composition, patches: Map<string, Partial<Block>>): Composition {
  if (!patches.size) return comp;
  return { ...comp, blocks: comp.blocks.map((b) => (patches.has(b.id) ? { ...b, ...patches.get(b.id) } : b)) };
}

/**
 * Pin the layers `ids` (all on `surface`) as one group to an anchor of the frame,
 * keeping their places relative to each other. `margin` is a fraction of the frame height.
 */
export function pinLayers(comp: Composition, surface: Surface, ids: string[], anchor: Pick<Anchor, 'ax' | 'ay'>, dimsOf: DimsOf, margin = 0): Composition {
  const fa = comp.frames[surface].aspect;
  const set = comp.blocks.filter((b) => b.surface === surface && ids.includes(b.id));
  if (!set.length) return comp;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of set) {
    const e = blockExtent(b, dimsOf(b), fa);
    x0 = Math.min(x0, b.x - e.w / 2);
    x1 = Math.max(x1, b.x + e.w / 2);
    y0 = Math.min(y0, b.y - e.h / 2);
    y1 = Math.max(y1, b.y + e.h / 2);
  }
  const { mx, my } = margins(margin, fa);
  const gw = x1 - x0, gh = y1 - y0;
  const tx = mx + anchor.ax * (1 - 2 * mx - gw) - x0;
  const ty = my + anchor.ay * (1 - 2 * my - gh) - y0;
  return patchBlocks(comp, new Map(set.map((b) => [b.id, { x: +(b.x + tx).toFixed(4), y: +(b.y + ty).toFixed(4) }])));
}

/**
 * Lay out the layers `ids` on `surface` in cells, in the order given (first = top
 * left). Each layer is turned straight and sized to fit its cell, keeping its proportions.
 */
export function layoutLayers(comp: Composition, surface: Surface, ids: string[], kind: LayoutKind, dimsOf: DimsOf, margin = 0.04, gap = 0.03): Composition {
  const fa = comp.frames[surface].aspect;
  const byId = new Map(comp.blocks.map((b) => [b.id, b]));
  const set = ids.map((id) => byId.get(id)).filter((b): b is Block => !!b && b.surface === surface);
  if (!set.length) return comp;
  const { cols, rows } = layoutGrid(kind, set.length, fa);
  const { mx, my } = margins(margin, fa);
  const gx = gap / fa, gy = gap;
  const cw = Math.max(0.01, (1 - 2 * mx - (cols - 1) * gx) / cols);
  const ch = Math.max(0.01, (1 - 2 * my - (rows - 1) * gy) / rows);
  const patches = new Map<string, Partial<Block>>();
  set.forEach((b, i) => {
    const cell = kind === 'stack' ? 0 : i;
    const col = cell % cols, row = Math.floor(cell / cols);
    const d = dimsOf(b) ?? { w: 1, h: 1 };
    // width = scale, height = scale * fa * h / w (frame fractions): fit both into the cell
    const scale = Math.min(cw, (ch * d.w) / (d.h * fa));
    patches.set(b.id, {
      x: +(mx + col * (cw + gx) + cw / 2).toFixed(4),
      y: +(my + row * (ch + gy) + ch / 2).toFixed(4),
      scale: +scale.toFixed(4),
      rotate: 0,
    });
  });
  return patchBlocks(comp, patches);
}

/** Id given to a surface's ordinary picture while it shows as a single layer. */
export const seedId = (s: Surface) => `seed-${s}`;
export const isSeed = (id: string) => id.startsWith('seed-');

/**
 * The layers each surface shows right now. A surface rendered from layers shows
 * them; a surface holding one ordinary picture (upload, pattern, sound, depth)
 * shows it as a single full-frame layer; blocks left on a surface whose picture
 * was since replaced wait in the tray.
 */
export function liveComposition(
  images: Partial<Record<Surface, ImageAsset>>,
  composition: Composition | undefined,
  topAspect: number,
  aspectOf: (a: ImageAsset) => number | null = () => null,
): Composition {
  let comp = composition ?? newComposition({ top: topAspect });
  for (const s of SURFACES) {
    const a = images[s];
    if (a?.composed) continue;
    if (comp.blocks.some((b) => b.surface === s)) comp = { ...comp, blocks: comp.blocks.map((b) => (b.surface === s ? { ...b, surface: null } : b)) };
    if (!a) continue;
    const source = a.pattern ? ({ kind: 'pattern', spec: a.pattern } as const) : ({ kind: 'image', name: a.name, dataUrl: a.dataUrl } as const);
    const b = { ...makeBlock(source, { surface: s, scale: 1 }), id: seedId(s) };
    // the frame takes the picture's own proportions, so the single layer fills it exactly
    const aspect = a.pattern ? a.pattern.aspect : aspectOf(a);
    const frames = aspect && Math.abs(aspect - comp.frames[s].aspect) > 1e-6 ? { ...comp.frames, [s]: { ...comp.frames[s], aspect } } : comp.frames;
    comp = { ...comp, frames, blocks: [...comp.blocks, b] };
  }
  return comp;
}

/** Same layer, ignoring where its node sits on the node board (that changes no picture). */
function sameLayer(a: Block, b: Block): boolean {
  if (a === b) return true;
  for (const k of Object.keys({ ...a, ...b }) as (keyof Block)[]) if (k !== 'node' && a[k] !== b[k]) return false;
  return true;
}

/** Surfaces whose picture differs between two versions of the live composition. */
export function changedSurfaces(a: Composition, b: Composition): Surface[] {
  return SURFACES.filter((s) => {
    if (a.frames[s] !== b.frames[s]) return true;
    const pa = a.blocks.filter((x) => x.surface === s), pb = b.blocks.filter((x) => x.surface === s);
    return pa.length !== pb.length || pa.some((x, i) => !sameLayer(x, pb[i]));
  });
}

/**
 * What to store after an edit of the live composition: surfaces that changed are
 * rendered from layers from now on, and each placeholder layer either becomes a
 * real block or, on a surface left as an ordinary picture, is dropped again.
 * `renamed` maps placeholder ids to their new ids so a selection can follow.
 */
export function settleComposition(before: Composition, after: Composition): { comp: Composition; changed: Surface[]; renamed: Map<string, string> } {
  const changed = changedSurfaces(before, after);
  const renamed = new Map<string, string>();
  const blocks: Block[] = [];
  for (const b of after.blocks) {
    if (!isSeed(b.id)) {
      blocks.push(b);
      continue;
    }
    // a placeholder still sitting untouched on its own ordinary picture stays a picture
    if (b.surface && !changed.includes(b.surface)) continue;
    const id = blockId();
    renamed.set(b.id, id);
    blocks.push({ ...b, id });
  }
  return { comp: { ...after, blocks }, changed, renamed };
}
