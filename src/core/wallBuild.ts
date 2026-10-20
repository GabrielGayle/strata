// Building on a wall: candles and postcards on a wall piece are laid out in the
// room and stand upright for real. Each comes to rest on the plate below it
// (a plate face when the plates run across the wall; when they hang down it, the
// seat it notches into them, or a plate's top edge), and a candle's flame keeps a clear chimney through any plate
// above it.
import type { CutObject } from './objects';
import type { Shape, Vec2 } from './geom2d';
import { pointInShape } from './geom2d';
import type { Plane } from './section';
import type { MountFrame, V3 } from './mount';
import type { Issue } from './checks';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

export interface RestPart {
  family: string;
  plane: Plane;
  shape: Shape;
  thickness: number;
}

/** Families a candle or card can stand on: the plates, not fins, shelves of cards or the base. */
const STANDS_ON = new Set(['P', 'X', 'R']);

/**
 * Heights (along `up`) of every plate surface a point could stand on: the top face
 * of a plate lying level under it, the top edge of an upright plate it is over, or
 * its own height where an upright plate runs through it (it notches a seat there).
 */
function surfacesUnder(parts: RestPart[], p: V3, up: V3, r: number, centre: V3 = p, radius = r): number[] {
  const out: number[] = [];
  for (const part of parts) {
    if (!STANDS_ON.has(part.family)) continue;
    const { origin, normal, u, v } = part.plane;
    const nu = dot(normal, up);
    const rel: V3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const at: Vec2 = [dot(rel, u), dot(rel, v)];
    if (Math.abs(nu) > 0.9) {
      // a plate lying level: its upper face, if the point is over it
      if (pointInShape(at, part.shape)) out.push(dot(origin, up) + part.thickness / 2);
      continue;
    }
    if (Math.abs(nu) > 0.2) continue; // slanted plates hold nothing up
    // an upright plate: only if the point is within reach of it
    if (Math.abs(dot(rel, normal)) >= r + part.thickness / 2) continue;
    // plate running through its foot: it cuts its own seat into the plate, whose floor holds it where it is
    const through = Math.abs((centre[0] - origin[0]) * normal[0] + (centre[1] - origin[1]) * normal[1] + (centre[2] - origin[2]) * normal[2]) < radius + part.thickness / 2;
    if (through && pointInShape(at, part.shape)) {
      out.push(dot(p, up));
      continue;
    }
    // up and across within the plate's own (u, v) coordinates
    const a: Vec2 = [dot(up, u), dot(up, v)];
    const al = Math.hypot(a[0], a[1]) || 1;
    a[0] /= al;
    a[1] /= al;
    const b: Vec2 = [-a[1], a[0]];
    const sb = at[0] * b[0] + at[1] * b[1];
    for (const e of part.shape) {
      for (const ring of [e.outer, ...e.holes]) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const pb = ring[i][0] * b[0] + ring[i][1] * b[1];
          const qb = ring[j][0] * b[0] + ring[j][1] * b[1];
          if (pb > sb === qb > sb) continue;
          const t = (sb - pb) / (qb - pb);
          const pa = ring[i][0] * a[0] + ring[i][1] * a[1];
          const qa = ring[j][0] * a[0] + ring[j][1] * a[1];
          const ha = pa + (qa - pa) * t;
          // a top edge: plate just below the crossing, open air just above
          const below: Vec2 = [b[0] * sb + a[0] * (ha - 0.05), b[1] * sb + a[1] * (ha - 0.05)];
          const above: Vec2 = [b[0] * sb + a[0] * (ha + 0.05), b[1] * sb + a[1] * (ha + 0.05)];
          if (pointInShape(below, part.shape) && !pointInShape(above, part.shape)) out.push(dot(origin, up) + ha * al);
        }
      }
    }
  }
  return out;
}

/**
 * Where something standing with its bottom at `bottom` comes to rest: the highest
 * plate surface under its footprint (sampled at the middle and round its edge) at
 * or below its bottom, else the lowest one above it. Null when nothing is under it.
 */
export function restHeight(parts: RestPart[], bottom: V3, f: MountFrame, r: number): number | null {
  const h0 = dot(bottom, f.up);
  const samples: V3[] = [bottom];
  const k = r * 0.7;
  if (k > 0.5) for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) samples.push(add(add(bottom, f.right, x * k), f.toward, z * k));
  const hs = samples.flatMap((s) => surfacesUnder(parts, s, f.up, Math.max(r, 1), bottom, r));
  if (!hs.length) return null;
  const below = hs.filter((h) => h <= h0 + 0.5);
  return below.length ? Math.max(...below) : Math.min(...hs);
}

/** Chimney kept clear above a flame, so no plate hangs over it. */
export function chimney(o: CutObject, up: V3): CutObject {
  const r = Math.max(o.w, 30);
  const h = Math.max(80, o.w * 3);
  const top = add([o.x, o.y, o.z], up, o.h / 2);
  const c = add(top, up, h / 2);
  return { id: `flame${o.id.slice(6)}`, name: `${o.name} flame`, kind: 'cylinder', w: r, h, d: r, x: c[0], y: c[1], z: c[2], rx: o.rx, ry: o.ry, rz: o.rz, clearance: 0, on: true, look: 'hidden' };
}

/**
 * Candles (and postcards) on a wall piece, already turned onto the model: each
 * drops onto the plate below it, and every candle gets its chimney. Objects that
 * aren't candles or cards pass through untouched.
 */
export function restOnWall(objs: CutObject[], parts: RestPart[], f: MountFrame): CutObject[] {
  const out: CutObject[] = [];
  for (const o of objs) {
    const candle = o.id.startsWith('candle');
    // shelf cards rest on the plates; objects placed by hand stay where they were put
    const card = o.kind === 'card' && o.id.startsWith('shelf');
    if (!candle && !card) {
      out.push(o);
      continue;
    }
    const bottom = add([o.x, o.y, o.z], f.up, -o.h / 2);
    const rest = restHeight(parts, bottom, f, candle ? o.w / 2 : Math.min(o.w / 2, 4));
    const moved = rest === null ? o : (() => {
      const c = add([o.x, o.y, o.z], f.up, rest - dot(bottom, f.up));
      return { ...o, x: c[0], y: c[1], z: c[2] };
    })();
    out.push(moved);
    if (candle) out.push(chimney(moved, f.up));
  }
  return out;
}

/**
 * A candle or card made for a table piece, readied for the wall: no wells, pads,
 * plate-top seats or chokes (they belong to plates rising from a base). Fins
 * become cheek fins when `cheekFins` (the plates lie level, so there is something
 * to key them onto), and go otherwise.
 */
export function forWall(objs: CutObject[], cheekFins = false): CutObject[] {
  return objs
    .filter((o) => !/^(well|pad)\d+$/.test(o.id))
    .map((o) => {
      if (!o.holder && o.seat === undefined && !o.choke && o.sink === undefined && o.shoulder === undefined) return o;
      const { holder, seat: _s, shoulder: _sh, choke: _c, sink: _k, ...rest } = o;
      // fins on a wall are cheek fins keyed onto the level plates (when there are level plates to key onto)
      return holder && cheekFins ? { ...rest, holder: { fins: 2, reach: holder.reach, grip: holder.grip, spin: 0, slotted: true, engage: holder.engage, wall: true } } : rest;
    });
}

/**
 * A candelabra laid out for a table, moved onto the face of a wall piece: the
 * path's left–right runs across the wall (`right`) and its back–front runs up–down
 * it, so a row of candles stays a row instead of a column of candles standing on
 * each other. Crown and Climb, which raise candles on a table, lift them up the
 * wall. Each candle stands out from the wall by Lift, its middle at its radius.
 */
export function onWallFace(objs: CutObject[], f: MountFrame, baseTop: number, lift: number): CutObject[] {
  return objs.map((o) => {
    const x = f.right[0] * o.x - f.up[0] * o.z;
    const z = f.right[2] * o.x - f.up[2] * o.z;
    // how far Crown and Climb raised it above Lift on the table
    const rise = Math.max(0, o.y - o.h / 2 - baseTop - lift);
    return { ...o, x: x + f.up[0] * rise, z: z + f.up[2] * rise, y: baseTop + lift + o.w / 2 };
  });
}

type Box = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** Whether a plate slab (plane, thickness) passes through a box. */
function slabCrosses(part: { plane: Plane; thickness: number }, b: Box): boolean {
  const n = part.plane.normal;
  const d = dot(part.plane.origin, n);
  let lo = Infinity, hi = -Infinity;
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
    const s = x * n[0] + y * n[1] + z * n[2] - d;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return lo < part.thickness / 2 && hi > -part.thickness / 2;
}

const names = (list: string[]) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', '));

/**
 * What goes wrong with candles on a wall that a table forgives: a candle with no
 * plate round it has nothing to stop it falling, and two candles laid out too close
 * stand inside each other.
 */
export function wallCandleIssues(candles: { object: CutObject; geometry: { boundingBox: Box | null } }[], parts: { family: string; plane: Plane; thickness: number }[]): Issue[] {
  const out: Issue[] = [];
  const cs = candles.filter((b) => /^candle\d+$/.test(b.object.id) && b.geometry.boundingBox);
  const holding = parts.filter((p) => STANDS_ON.has(p.family) || p.family === 'H');
  // a candle standing on a level plate touches it: grow each box a little so that counts as held
  const grown = (b: Box): Box => ({ min: { x: b.min.x - 1, y: b.min.y - 1, z: b.min.z - 1 }, max: { x: b.max.x + 1, y: b.max.y + 1, z: b.max.z + 1 } });
  const loose = cs.filter((b) => !holding.some((p) => slabCrosses(p, grown(b.geometry.boundingBox!)))).map((b) => b.object.name);
  if (loose.length)
    out.push({ partId: null, type: 'general', severity: 'warn', message: `${loose.length} candle${loose.length > 1 ? 's' : ''} on the wall (${names(loose)}) ${loose.length > 1 ? 'have' : 'has'} no plate round ${loose.length > 1 ? 'them' : 'it'} and would fall: move ${loose.length > 1 ? 'them' : 'it'} onto the plates (Snap › Centre in the cells, or a smaller Size).` });
  const clash: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i].object, b = cs[j].object;
      // upright cylinders on a wall: closer than their radii across, and overlapping along their length
      const ax = cs[i].geometry.boundingBox!, bx = cs[j].geometry.boundingBox!;
      const overlap = (['x', 'y', 'z'] as const).every((k) => Math.min(ax.max[k], bx.max[k]) - Math.max(ax.min[k], bx.min[k]) > 0.5);
      if (overlap) clash.push(`${a.name} and ${b.name}`);
    }
  }
  if (clash.length)
    out.push({ partId: null, type: 'general', severity: 'warn', message: `Candles stand inside each other on the wall (${names(clash)}): spread the path (Size), or use fewer candles.` });
  return out;
}
