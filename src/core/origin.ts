// World origin: the point placed objects and the postcard shelf are measured
// from. It sits on a chosen spot of the base, nudged by an offset and turned,
// and everything measured from it moves and turns with it.
//
// On a wall piece everything stays where it is on the piece (positions are the
// model's, so a design hung on the wall keeps its candles and cards in the same
// spots on its face), but stands upright for real: an object's own turns are
// measured in the room, about the real vertical.
import * as THREE from 'three';
import type { Values } from './params';
import type { CutObject } from './objects';
import { baseTop } from './slicer';
import { mountFrame, type MountFrame } from './mount';

export type OriginRef = 'floor' | 'top' | 'front' | 'corner';

export const ORIGIN_NAMES: Record<OriginRef, string> = {
  floor: 'Floor, under the middle of the base',
  top: 'Middle of the concrete top',
  front: 'Front edge of the concrete top',
  corner: 'Front-left corner of the concrete top',
};

export interface WorldOrigin {
  ref: OriginRef;
  /** Offset from the reference point (mm), along the turned axes. */
  x: number;
  y: number;
  z: number;
  /** Turn about the vertical (degrees). */
  turn: number;
}

export const DEFAULT_ORIGIN: WorldOrigin = { ref: 'floor', x: 0, y: 0, z: 0, turn: 0 };

export interface Frame {
  p: [number, number, number];
  /** Radians about y. */
  turn: number;
  /** Wall pieces: placed things are stood upright in the room this frame describes. */
  room?: MountFrame;
}

const num = (x: unknown, def = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : def);

export function cleanOrigin(raw: unknown): WorldOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const ref = (Object.keys(ORIGIN_NAMES) as OriginRef[]).includes(r.ref as OriginRef) ? (r.ref as OriginRef) : 'floor';
  return { ref, x: num(r.x), y: num(r.y), z: num(r.z), turn: num(r.turn) };
}

/** Where the origin is in the world, and which way it faces. Front is +z (towards the 3D view's starting camera). */
export function originFrame(o: WorldOrigin | undefined, v: Values, map = false): Frame {
  const g = o ?? DEFAULT_ORIGIN;
  const top = baseTop(v);
  const L = Number(v.baseLength) || 0;
  const W = Number(v.baseWidth) || 0;
  const ref: [number, number, number] = g.ref === 'top' ? [0, top, 0] : g.ref === 'front' ? [0, top, W / 2] : g.ref === 'corner' ? [-L / 2, top, W / 2] : [0, 0, 0];
  const a = (g.turn * Math.PI) / 180;
  // the offset runs along the turned axes, like moving the origin in its own frame
  const p: [number, number, number] = [ref[0] + g.x * Math.cos(a) + g.z * Math.sin(a), ref[1] + g.y, ref[2] - g.x * Math.sin(a) + g.z * Math.cos(a)];
  const f = mountFrame(v, map);
  return f.mount === 'wall' ? { p, turn: a, room: f } : { p, turn: a };
}

/** The origin's place and facing on the model, for drawing its axes (upright in the room on a wall). */
export function framePose(f: Frame): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.turn);
  const q = f.room ? new THREE.Quaternion().setFromRotationMatrix(roomMatrix(f.room)).multiply(turn) : turn;
  return { position: new THREE.Vector3(...f.p), quaternion: q };
}

/** Rotation turning room directions onto the model. */
function roomMatrix(f: MountFrame): THREE.Matrix4 {
  const [r, u, t] = [f.right, f.up, f.toward];
  return new THREE.Matrix4().set(r[0], u[0], t[0], 0, r[1], u[1], t[1], 0, r[2], u[2], t[2], 0, 0, 0, 0, 1);
}

/**
 * An object stood upright in the room: it stays where it is on the model, and its
 * own axes (its turns, measured with y as the real up) are turned with the room.
 * The identity for a table piece.
 */
export function standUpright(o: CutObject, room: MountFrame | undefined): CutObject {
  if (!room) return o;
  const R = (deg: number) => (deg * Math.PI) / 180;
  const m = roomMatrix(room).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(R(o.rx), R(o.ry), R(o.rz), 'YXZ')));
  const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
  const D = (rad: number) => Math.round(((rad * 180) / Math.PI) * 1e6) / 1e6;
  return { ...o, rx: D(e.x), ry: D(e.y), rz: D(e.z) };
}

export const isIdentityFrame = (f: Frame) => !f.room && !f.turn && !f.p[0] && !f.p[1] && !f.p[2];

// one placed copy per object and frame, so unchanged objects keep their cached sections
const placed = new WeakMap<CutObject, { key: string; out: CutObject }>();

/**
 * An object measured from the origin, placed in the world. With `keepY` the
 * height stays as given (shelf cards are already set on the concrete).
 */
export function toWorld(o: CutObject, f: Frame, keepY = false): CutObject {
  if (isIdentityFrame(f)) return o;
  const key = `${f.p.join(',')},${f.turn},${keepY},${f.room ? f.room.up.join(',') : ''}`;
  const hit = placed.get(o);
  if (hit && hit.key === key) return hit.out;
  const c = Math.cos(f.turn);
  const s = Math.sin(f.turn);
  const out: CutObject = {
    ...o,
    x: f.p[0] + o.x * c + o.z * s,
    y: keepY ? o.y : f.p[1] + o.y,
    z: f.p[2] - o.x * s + o.z * c,
    ry: o.ry + (f.turn * 180) / Math.PI,
  };
  const turned = standUpright(out, f.room);
  placed.set(o, { key, out: turned });
  return turned;
}
