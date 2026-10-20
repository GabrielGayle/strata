// Candles placed one at a time by clicking a surface in the 3D view: a shelf,
// the plate tops or the concrete. Each gets fins worked out for where it
// stands: on a shelf the fins drop tabs into slots in it, on the plate tops
// they slot down onto the plates, on the concrete they stand in it like a
// target. They are separate from the candelabra and borrow only its holder
// settings (fins, reach, grip, slack…), so a design can have both.
import type { CutObject } from './objects';
import { crossPedestal, DEFAULT_CANDLES, parseCandles, type CandleSize, type CandleSpec } from './candles';
import { onShelf, type ShelfCut } from './shelfPlates';

export type SurfaceKind = 'shelf' | 'plates' | 'base';

export const SURFACE_NAMES: Record<SurfaceKind, string> = {
  shelf: 'on a shelf',
  plates: 'on the plate tops',
  base: 'on the concrete',
};

export interface PlacedCandle {
  id: string;
  /** A candle line, as typed in the candelabra list: "taper", "maxi", "24 x 300 stick". */
  size: string;
  on: SurfaceKind;
  /** The shelf it stands on (when on a shelf). */
  shelf?: string;
  /** Where it stands in plan (mm): world x, z, or from the shelf's centre when on a shelf. */
  x: number;
  z: number;
}

const num = (x: unknown, def: number) => (typeof x === 'number' && Number.isFinite(x) ? x : def);

export function cleanPlacedCandles(raw: unknown): PlacedCandle[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PlacedCandle[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const on = o.on === 'shelf' || o.on === 'plates' || o.on === 'base' ? o.on : 'base';
    const id = typeof o.id === 'string' && o.id ? o.id : `pc${out.length + 1}`;
    if (out.some((c) => c.id === id)) continue;
    out.push({ id, size: typeof o.size === 'string' && o.size.trim() ? o.size : 'taper', on, ...(on === 'shelf' && typeof o.shelf === 'string' ? { shelf: o.shelf } : {}), x: num(o.x, 0), z: num(o.z, 0) });
  }
  return out.length ? out : undefined;
}

export function newPlacedCandle(existing: PlacedCandle[], c: Omit<PlacedCandle, 'id'>): PlacedCandle {
  const ids = new Set(existing.map((p) => p.id));
  let n = existing.length + 1;
  while (ids.has(`pc${n}`)) n++;
  return { id: `pc${n}`, ...c, x: Math.round(c.x * 10) / 10, z: Math.round(c.z * 10) / 10 };
}

/** The candle a placed line names (a dinner candle if it names nothing). */
export function placedSize(c: PlacedCandle): CandleSize {
  return parseCandles(c.size).lines[0]?.size ?? parseCandles('taper').lines[0].size;
}

/** World plan position of a placed candle (shelf candles are kept relative to their shelf). */
export function placedAt(c: PlacedCandle, shelves: ShelfCut[]): [number, number] | null {
  if (c.on !== 'shelf') return [c.x, c.z];
  const s = shelves.find((x) => x.id === c.shelf);
  return s ? [s.x + c.x, s.z + c.z] : null;
}

/**
 * The cutters and holders for every placed candle. Candles on the plate tops
 * come out at the concrete: `topAt` (the lowest plate top under a circle, from
 * a pass without them) drops each one in to its grip.
 */
export function placedCandleObjects(
  list: PlacedCandle[] | undefined,
  spec: CandleSpec | undefined,
  shelves: ShelfCut[],
  baseTop: number,
  embed: number,
  minFeature: number,
  topAt: ((x: number, z: number, r: number) => number | null) | null,
): { objects: CutObject[]; lost: string[] } {
  const s = { ...DEFAULT_CANDLES, ...(spec ?? {}) };
  const objects: CutObject[] = [];
  const lost: string[] = [];
  for (const c of list ?? []) {
    const size = placedSize(c);
    const at = placedAt(c, shelves);
    const shelf = c.on === 'shelf' ? shelves.find((x) => x.id === c.shelf) : undefined;
    if (!at || (c.on === 'shelf' && (!shelf || !onShelf(shelf, at[0], at[1])))) {
      lost.push(c.id);
      continue;
    }
    const [x, z] = at;
    const grip = size.tealight ? Math.min(s.cup, size.h - 1) : Math.min(s.grip, size.h - 2);
    // two-piece cross fins when the candelabra asks for them (Fin style)
    const cross = s.finJoin === 'cross';
    const holder = { fins: s.fins, reach: s.reach, grip, spin: s.spin, ...(cross ? { cross } : {}) };
    const base = { kind: 'cylinder' as const, x, z, rx: 0, ry: 0, rz: 0, on: true, w: size.d, d: size.d, h: size.h, clearance: s.slack, look: size.tealight ? ('tealight' as const) : ('candle' as const), name: size.name };
    const rw = size.d / 2 + s.slack + s.reach + Math.max(2, s.slack * 2);
    if (shelf) {
      // stands on the shelf (a two-piece cross lifts it onto the pedestal its halves need); above it the plates are cleared for its fins
      const yb = shelf.top + (cross ? crossPedestal(minFeature) : 0);
      objects.push({ ...base, id: c.id, y: yb + size.h / 2, holder: { ...holder, shelf: { id: shelf.id, top: shelf.top, t: shelf.t } } });
      objects.push({ ...base, id: `${c.id}well`, name: `${size.name} holder`, look: 'hidden', w: 2 * rw, d: 2 * rw, h: yb + size.h - shelf.top, y: (shelf.top + yb + size.h) / 2, clearance: 0 });
      continue;
    }
    if (c.on === 'plates') {
      // slotted fins drop onto the plates; the candle sinks in by its grip below the lowest plate top under it
      const top = topAt?.(x, z, size.d / 2 + s.slack) ?? null;
      if (top === null) {
        lost.push(c.id);
        continue;
      }
      const yb = top - grip;
      objects.push({ ...base, id: c.id, y: yb + size.h / 2, sink: grip, holder: { ...holder, slotted: true, engage: s.engage } });
      continue;
    }
    // on the concrete: target fins set in it, the plates cleared round them (down where they sink in too) up past the candle
    const bottom = baseTop - (embed > 0 ? embed + 0.5 : -0.2);
    const top = baseTop + size.h;
    objects.push({ ...base, id: c.id, y: baseTop + size.h / 2, holder });
    objects.push({ ...base, id: `${c.id}well`, name: `${size.name} holder`, look: 'hidden', w: 2 * rw, d: 2 * rw, h: top - bottom, y: (bottom + top) / 2, clearance: 0 });
  }
  return { objects, lost };
}
