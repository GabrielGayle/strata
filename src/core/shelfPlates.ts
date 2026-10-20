// Shelves: flat metal plates running across the upright plates, for candles
// and other things to stand on. Each plate a shelf crosses gets a slot the
// shelf's own size, so the shelf slides through the whole stack from one side,
// like a rod, and is welded where it passes each plate.
import type { CutObject } from './objects';
import type { Values } from './params';
import { stackFrame } from './heightfield';
import { offset, rect, type Shape } from './geom2d';
import type { Plane } from './section';

export interface ShelfPlate {
  id: string;
  name: string;
  /** Centre in plan, world mm. */
  x: number;
  z: number;
  /** Height of the shelf's top face above the floor (mm). */
  y: number;
  /** Length across the plates (along the stack) and depth along them (mm). */
  len: number;
  depth: number;
  /** Thickness (mm); 0 uses the plate thickness. */
  thick: number;
  /** Corner radius in plan (mm). */
  round: number;
  /** Gap round the shelf in every plate slot (mm), so it slides through. */
  fit: number;
  on: boolean;
}

export const SHELF_DEFAULTS = { len: 160, depth: 100, thick: 0, round: 6, fit: 0.3 };

const num = (x: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def);

export function newShelf(existing: ShelfPlate[], at: { x: number; y: number; z: number }): ShelfPlate {
  const ids = new Set(existing.map((s) => s.id));
  let n = existing.length + 1;
  while (ids.has(`hs${n}`)) n++;
  const r1 = (x: number) => Math.round(x);
  return { id: `hs${n}`, name: `Shelf ${n}`, x: r1(at.x), y: r1(at.y), z: r1(at.z), ...SHELF_DEFAULTS, on: true };
}

/** Shelves read from a file, with anything missing or broken filled in. */
export function cleanShelfPlates(raw: unknown): ShelfPlate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ShelfPlate[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id ? o.id : `hs${out.length + 1}`;
    if (out.some((s) => s.id === id)) continue;
    out.push({
      id,
      name: typeof o.name === 'string' ? o.name : `Shelf ${out.length + 1}`,
      x: num(o.x, 0),
      y: num(o.y, 60),
      z: num(o.z, 0),
      len: num(o.len, SHELF_DEFAULTS.len, 10, 5000),
      depth: num(o.depth, SHELF_DEFAULTS.depth, 10, 5000),
      thick: num(o.thick, 0, 0, 50),
      round: num(o.round, SHELF_DEFAULTS.round, 0, 500),
      fit: num(o.fit, SHELF_DEFAULTS.fit, 0, 5),
      on: o.on !== false,
    });
  }
  return out.length ? out : undefined;
}

export const shelfThickness = (s: ShelfPlate, v: Values) => (s.thick > 0 ? s.thick : Math.max(0.5, Number(v.thickness) || 3));

/** The shelf's size in world plan: x and z extents (it lies square to the stack). */
export function shelfSize(s: ShelfPlate, v: Values): { sx: number; sz: number } {
  const alongX = stackFrame(v).stack[0] !== 0;
  return alongX ? { sx: s.len, sz: s.depth } : { sx: s.depth, sz: s.len };
}

/** The cutters that slot every plate a shelf crosses: a hidden box the shelf's size, grown by its fit. */
export function shelfSlotObjects(shelves: ShelfPlate[] | undefined, v: Values): CutObject[] {
  if (!shelves?.length || v.sliceMode === 'flat') return [];
  return shelves
    .filter((s) => s.on)
    .map((s) => {
      const t = shelfThickness(s, v);
      const { sx, sz } = shelfSize(s, v);
      return { id: `hslot-${s.id}`, name: `${s.name} slot`, kind: 'box', w: sx, h: t, d: sz, x: s.x, y: s.y - t / 2, z: s.z, rx: 0, ry: 0, rz: 0, clearance: s.fit, on: true, look: 'hidden' } satisfies CutObject;
    });
}

/** What the slicer needs to cut a shelf: where it is, how big, how thick. */
export interface ShelfCut {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Top face height (world mm). */
  top: number;
  t: number;
  sx: number;
  sz: number;
  round: number;
}

export function shelfCuts(shelves: ShelfPlate[] | undefined, v: Values): ShelfCut[] {
  if (!shelves?.length || v.sliceMode === 'flat') return [];
  return shelves.filter((s) => s.on).map((s) => ({ id: s.id, name: s.name, x: s.x, z: s.z, top: s.y, t: shelfThickness(s, v), ...shelfSize(s, v), round: s.round }));
}

/** A shelf lies flat: plan coordinates (x, -z), like the steel base, centred through its thickness. */
export function shelfPlane(c: ShelfCut): Plane {
  return { origin: [0, c.top - c.t / 2, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] };
}

/** The shelf outline in its own plane: a rectangle with its corners rounded. */
export function shelfOutline(c: ShelfCut): Shape {
  const x0 = c.x - c.sx / 2, x1 = c.x + c.sx / 2;
  const y0 = -c.z - c.sz / 2, y1 = -c.z + c.sz / 2;
  const r = Math.max(0, Math.min(c.round, c.sx / 2 - 0.5, c.sz / 2 - 0.5));
  if (r < 0.1) return rect(x0, y0, x1, y1);
  return offset(rect(x0 + r, y0 + r, x1 - r, y1 - r), r, 'round', 0.02);
}

/** Whether a plan point (world x, z) lies on a shelf's top. */
export function onShelf(c: { x: number; z: number; sx: number; sz: number }, x: number, z: number): boolean {
  return Math.abs(x - c.x) <= c.sx / 2 && Math.abs(z - c.z) <= c.sz / 2;
}
