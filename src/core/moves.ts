// Per-part placement overrides ("slat moves"). A part keeps the outline it was
// designed with; the move carries it to a new spot as a rigid body, and every
// fit-dependent cut (cavities, slots, tenons) is then made where it now sits.
import type { Plane, V3 } from './section';

export interface PartMove {
  /** World offset of the pivot, mm. */
  t: V3;
  /** Rotation about the pivot, as a unit quaternion [x, y, z, w]. */
  q: [number, number, number, number];
}

export type PartMoves = Record<string, PartMove>;

export const IDENTITY_MOVE: PartMove = { t: [0, 0, 0], q: [0, 0, 0, 1] };

export function isIdentity(m: PartMove | undefined): boolean {
  if (!m) return true;
  const [x, y, z, w] = m.q;
  return Math.hypot(...m.t) < 1e-6 && Math.abs(Math.abs(w) - 1) < 1e-9 && Math.hypot(x, y, z) < 1e-9;
}

export function rotate(q: PartMove['q'], v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  // v + 2w(q×v) + 2 q×(q×v)
  const cx = qy * v[2] - qz * v[1], cy = qz * v[0] - qx * v[2], cz = qx * v[1] - qy * v[0];
  const dx = qy * cz - qz * cy, dy = qz * cx - qx * cz, dz = qx * cy - qy * cx;
  return [v[0] + 2 * (qw * cx + dx), v[1] + 2 * (qw * cy + dy), v[2] + 2 * (qw * cz + dz)];
}

/** The plane a part sits on after a move about `pivot` (world). */
export function movePlane(p: Plane, m: PartMove | undefined, pivot: V3): Plane {
  if (isIdentity(m)) return p;
  const { t, q } = m!;
  const o = rotate(q, [p.origin[0] - pivot[0], p.origin[1] - pivot[1], p.origin[2] - pivot[2]]);
  return {
    origin: [pivot[0] + t[0] + o[0], pivot[1] + t[1] + o[1], pivot[2] + t[2] + o[2]],
    normal: rotate(q, p.normal),
    u: rotate(q, p.u),
    v: rotate(q, p.v),
  };
}

/** Drop identity entries and anything that isn't a well-formed move (old or hand-edited files). */
export function cleanMoves(raw: unknown): PartMoves | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: PartMoves = {};
  for (const [k, m] of Object.entries(raw as Record<string, any>)) {
    const ok = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!m || !ok(m.t, 3) || !ok(m.q, 4)) continue;
    const len = Math.hypot(...(m.q as number[])) || 1;
    const mv: PartMove = { t: [...m.t] as V3, q: (m.q as number[]).map((x) => x / len) as PartMove['q'] };
    if (!isIdentity(mv)) out[k] = mv;
  }
  return Object.keys(out).length ? out : undefined;
}
