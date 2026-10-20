// How the finished piece is shown: standing on a table, or hung on a wall.
//
// The model itself never turns. Its coordinates stay as the slicer makes them
// (+Y away from the base, base top at baseTop(v)), so plates, nests and laser
// files are the same either way. A wall piece hangs with the underside of its
// base flat on the wall, so the model's +Y points out into the room and one edge
// of the base is at the top. This file says which way is really up, which way the
// piece faces, and turns directions between the model and the room.
import { stackFrame } from './heightfield';
import type { Values } from './params';
import type { Issue } from './checks';

export type V3 = [number, number, number];
export type Mount = 'table' | 'wall';
export type WallTop = 'picture' | 'back' | 'front' | 'left' | 'right';

export interface MountFrame {
  mount: Mount;
  /** Real-world up, in model coordinates. */
  up: V3;
  /** Towards someone standing in front of the piece (the room's +z), in model coordinates. */
  toward: V3;
  /** To that person's right (the room's +x): up × toward. */
  right: V3;
  /** The level direction the piece faces out to, which Sun › Front faces is a bearing of. */
  facing: V3;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const mountOf = (v: Values): Mount => (v.mount === 'wall' ? 'wall' : 'table');
export const isWall = (v: Values) => mountOf(v) === 'wall';

/**
 * The base edge at the top of a wall piece, as a model direction. "Picture" puts
 * the top of the top image at the top (north for a map), so a relief reads upright.
 * The edges match Steel base › Edge: back and front are the ends of the base (+x
 * and −x; the front end is the one the Front view looks at), left and right are
 * as seen from the front (−z and +z).
 */
export function wallUp(v: Values, map = false): V3 {
  const top = (['picture', 'back', 'front', 'left', 'right'] as const).includes(v.wallTop) ? (v.wallTop as WallTop) : 'picture';
  if (top === 'back') return [1, 0, 0];
  if (top === 'front') return [-1, 0, 0];
  if (top === 'left') return [0, 0, -1];
  if (top === 'right') return [0, 0, 1];
  const f = stackFrame(v);
  // plates hanging down the wall: the picture is turned a quarter, its top now on the right as
  // seen from above with the front at the bottom (a map can't turn, so it hangs sideways)
  if (v.wallPlates === 'down') return [-f.stack[1], 0, f.stack[0]];
  // the top image's top is the far end of the stack; a map's top (north) is the front end
  const s = map ? -1 : 1;
  return [s * f.stack[0], 0, s * f.stack[1]];
}

/** `map`: the top face is a map, whose picture top (north) is the front end. */
export function mountFrame(v: Values, map = false): MountFrame {
  if (isWall(v)) {
    const up = wallUp(v, map);
    const toward: V3 = [0, 1, 0];
    return { mount: 'wall', up, toward, right: cross(up, toward), facing: toward };
  }
  const f = stackFrame(v);
  // a table piece faces out of its front end, the one the Front view looks at
  return { mount: 'table', up: [0, 1, 0], toward: [0, 0, 1], right: [1, 0, 0], facing: [-f.stack[0], 0, -f.stack[1]] };
}

/** A room direction or point (x right, y up, z towards the viewer) in model coordinates. */
export function roomToModel(f: MountFrame, p: V3): V3 {
  return [
    f.right[0] * p[0] + f.up[0] * p[1] + f.toward[0] * p[2],
    f.right[1] * p[0] + f.up[1] * p[1] + f.toward[1] * p[2],
    f.right[2] * p[0] + f.up[2] * p[1] + f.toward[2] * p[2],
  ];
}

/** A model direction or point in room coordinates (y up). */
export function modelToRoom(f: MountFrame, p: V3): V3 {
  return [dot(f.right, p), dot(f.up, p), dot(f.toward, p)];
}

/**
 * Column-major 4×4 turning model coordinates into the room's (y up), for
 * THREE.Matrix4.fromArray. The identity for a table piece.
 */
export function modelToRoomMatrix(f: MountFrame): number[] {
  const [r, u, t] = [f.right, f.up, f.toward];
  return [r[0], u[0], t[0], 0, r[1], u[1], t[1], 0, r[2], u[2], t[2], 0, 0, 0, 0, 1];
}

/**
 * Level direction of a compass bearing, in model coordinates. Sun › Front faces
 * is the bearing of `facing`; bearings turn clockwise seen from above.
 */
export function bearingDir(v: Values, bearing: number, f = mountFrame(v)): V3 {
  const t = ((bearing - (Number(v.sunFacing) || 0)) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const r = cross(f.facing, f.up);
  return [f.facing[0] * c + r[0] * s, f.facing[1] * c + r[1] * s, f.facing[2] * c + r[2] * s];
}

/** Towards the sun at this azimuth and elevation (degrees), in model coordinates. */
export function sunDir(v: Values, azimuth: number, elevation: number, f = mountFrame(v)): V3 {
  const h = bearingDir(v, azimuth, f);
  const e = (elevation * Math.PI) / 180;
  const ce = Math.cos(e);
  const se = Math.sin(e);
  return [h[0] * ce + f.up[0] * se, h[1] * ce + f.up[1] * se, h[2] * ce + f.up[2] * se];
}

/** The sun is behind the wall a wall piece hangs on (or below the horizon). */
export function sunBehindWall(v: Values, dir: V3, f = mountFrame(v)): boolean {
  return f.mount === 'wall' && dot(dir, f.toward) <= 0;
}

const EDGE_NAME: Record<string, string> = { back: 'Back end', front: 'Front end', left: 'Left side', right: 'Right side' };

/** The base edge (Steel base › Edge value) nearest a model direction. */
function edgeOf(d: V3): string {
  if (Math.abs(d[0]) >= Math.abs(d[2])) return d[0] > 0 ? 'back' : 'front';
  return d[2] < 0 ? 'left' : 'right';
}

/** The Steel base › Edge that is at the top of this wall piece. */
export const wallTopEdge = (v: Values, map = false) => edgeOf(wallUp(v, map));

/** Kilograms above which a wall piece wants more than a picture hook. */
export const WALL_HEAVY_KG = 15;

const warn = (message: string): Issue => ({ partId: null, type: 'general', severity: 'warn', message });
const info = (message: string): Issue => ({ partId: null, type: 'general', severity: 'info', message });

/**
 * What a wall piece needs that a table piece doesn't: a way to hang it, keyholes
 * that point up, and things that only work standing up (flames, shadow pictures,
 * level shelves). Empty for a table piece.
 */
export function mountIssues(v: Values, has: { candles?: boolean; shelf?: boolean; shelves?: boolean; map?: boolean }): Issue[] {
  if (!isWall(v)) return [];
  const out: Issue[] = [];
  if (v.steelBaseOn) {
    if (String(v.steelHoles) === '0') out.push(warn('Wall piece with no fixing holes: set Steel base › Fixing holes (keyholes hang it on screws) or plan another fixing.'));
    else {
      const top = wallTopEdge(v, has.map);
      const keyhole = v.steelHoleStyle === 'keyhole';
      if (keyhole && v.steelHoleSide !== top) {
        out.push(warn(`The keyholes point at the ${EDGE_NAME[String(v.steelHoleSide)] ?? v.steelHoleSide}, but the ${EDGE_NAME[top]} is at the top on the wall, so the piece would slide off its screws. Set Steel base › Edge to ${EDGE_NAME[top]}.`));
      }
    }
  } else if (v.baseOn) {
    out.push(info('Wall piece on a concrete base: cast fixings (threaded inserts or a keyhole plate) into the back of the base, or switch Base › Base is to Steel plate for laser-cut keyholes.'));
  } else {
    out.push(warn('Wall piece with no base: the plates need something to hang from. Turn the Base on (a steel plate gets keyholes).'));
  }
  if (has.map && v.wallPlates === 'down' && (v.wallTop ?? 'picture') === 'picture') out.push(info('A map stays north along the stack, so with the plates hanging down the wall it hangs on its side. Set Plates run to Across for north up.'));
  if (has.candles) out.push(info('On a wall each candle stands upright on the plate below it, in a cup cut through the plates it passes, with a clear chimney above its flame. Fins, chokes and trimmed plate tops are for table pieces.'));
  if (v.shadowOn) out.push(info('Shadow pictures are worked out for a piece standing on a table; switch Display › Shown on to Table to design them.'));
  if (has.shelf) out.push(info('On a wall the postcards stand upright on the plate below each one, notched through the plates they pass. Seats and the unobstructed view are for table pieces.'));
  if (has.shelves) out.push(warn('Shelves are level on a table piece; on the wall they stand straight out from it, so anything on them would lean. Switch Display › Shown on to Table, or leave shelves off.'));
  return out;
}

/** The weight warning, once the bill of materials is known. */
export function mountWeightIssue(v: Values, kg: number): Issue | null {
  if (!isWall(v) || !(kg > WALL_HEAVY_KG)) return null;
  return warn(`This wall piece weighs about ${kg.toFixed(0)} kg. Hang it on wall plugs and screws rated for well over that, into a solid wall or studs, not picture hooks.`);
}
