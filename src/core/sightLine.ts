// Sight lines for Unobstructed view: the space between each postcard face and
// the viewer. Plates that stand in it are cut back so the picture shows, apart
// from the seat strip along the card's bottom edge that the plates hold.
import * as THREE from 'three';
import { signedArea, type Path, type Shape, type Vec2 } from './geom2d';
import { objectMatrix, type CutObject } from './objects';
import type { Plane, V3 } from './section';

/** How far the sight line runs toward the viewer: well past any shelf. */
const REACH = 4000;

export interface SightCard {
  id: string;
  /** Corners of the card box above its seat strip (world mm). */
  box: V3[];
}

/** The part of a card that must be seen: everything above the seat strip, grown by `pad` on the sides and faces. */
export function sightCard(o: CutObject, seat: number, pad: number): SightCard | null {
  const hw = o.w / 2 + pad;
  const hh = o.h / 2;
  const hd = o.d / 2 + pad;
  const y0 = -hh + Math.max(0, seat);
  if (y0 >= hh) return null;
  const m = objectMatrix(o);
  const box: V3[] = [];
  for (const x of [-hw, hw])
    for (const y of [y0, hh + pad])
      for (const z of [-hd, hd]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(m);
        box.push([p.x, p.y, p.z]);
      }
  return { id: o.id, box };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function hull(pts: Vec2[]): Path {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: Vec2, a: Vec2, c: Vec2) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Where a card's sight line passes through a plate of thickness `t`, in the plate's own
 * coordinates: the card box swept toward the eye, cut by the plate's slab. The sweep is
 * convex, so the slab cut is the hull of its corners inside the slab and its edges' crossings
 * of the two faces.
 */
export function sightSection(card: SightCard, eye: V3, plane: Plane, t: number): Shape {
  const far = card.box.map((p): V3 => [p[0] + eye[0] * REACH, p[1] + eye[1] * REACH, p[2] + eye[2] * REACH]);
  const pts3 = [...card.box, ...far];
  const w = pts3.map((p) => dot(sub(p, plane.origin), plane.normal));
  const half = t / 2;
  if (Math.max(...w) < -half || Math.min(...w) > half) return [];
  const uv = (p: V3): Vec2 => {
    const d = sub(p, plane.origin);
    return [dot(d, plane.u), dot(d, plane.v)];
  };
  const out: Vec2[] = [];
  for (let i = 0; i < pts3.length; i++) {
    if (Math.abs(w[i]) <= half) out.push(uv(pts3[i]));
    for (let j = i + 1; j < pts3.length; j++) {
      for (const face of [-half, half]) {
        const a = w[i] - face;
        const b = w[j] - face;
        if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
          const s = a / (a - b);
          const p = pts3[i];
          const q = pts3[j];
          out.push(uv([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s]));
        }
      }
    }
  }
  const h = hull(out);
  if (h.length < 3 || Math.abs(signedArea(h)) < 1e-4) return [];
  return [{ outer: signedArea(h) > 0 ? h : [...h].reverse(), holes: [] }];
}

/** Every card's sight line through one plate. */
export function sightCut(cards: SightCard[], eye: V3, plane: Plane, t: number): Shape {
  return cards.flatMap((c) => sightSection(c, eye, plane, t));
}
