// Unroll ruled/developable surfaces (cylinder, cone, lofts, fins) into flat
// patterns, with bend lines and bend allowance for faceted versions.
// Double-curved forms are detected by the stretch the unroll would need.
import * as THREE from 'three';
import { ringsWithCount, type Form } from './forms';
import { bboxOf, shapeArea, signedArea, union, type Path, type Vec2 } from './geom2d';
import type { Values } from './params';

export interface Bend {
  angle: number; // degrees
  ba: number; // bend allowance (mm)
  bd: number; // bend deduction (mm)
  line: Path;
}

export interface UnfoldPiece {
  id: string;
  outline: Path;
  bends: Bend[];
  area: number;
  w: number;
  h: number;
  overlaps: boolean;
}

export interface UnfoldResult {
  ok: boolean;
  developable: boolean;
  maxStretch: number; // relative
  message: string;
  pieces: UnfoldPiece[];
  caps: UnfoldPiece[];
  thickness: number;
}

function place(A: Vec2, B: Vec2, dA: number, dB: number, R: Vec2 | null): Vec2 {
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const d = Math.hypot(dx, dy) || 1e-9;
  const a = (dA * dA - dB * dB + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, dA * dA - a * a));
  const ex = dx / d, ey = dy / d;
  const px = A[0] + a * ex, py = A[1] + a * ey;
  const c1: Vec2 = [px - h * ey, py + h * ex];
  const c2: Vec2 = [px + h * ey, py - h * ex];
  if (!R) return c1;
  const side = (p: Vec2) => dx * (p[1] - A[1]) - dy * (p[0] - A[0]);
  return Math.sign(side(c1)) !== Math.sign(side(R)) ? c1 : c2;
}

function unrollColumns(V: THREE.Vector3[][], j0: number, j1: number): { P: Vec2[][]; err: number } {
  const L = V.length;
  const N = V[0].length; // ring points (closed); column j maps to V[i][j % N]
  const at = (i: number, j: number) => V[i][j % N];
  const dist = (i0: number, ja: number, i1: number, jb: number) => at(i0, ja).distanceTo(at(i1, jb));
  const P: Vec2[][] = Array.from({ length: L }, () => new Array(j1 - j0 + 1));
  const get = (i: number, j: number) => P[i][j - j0];
  const set = (i: number, j: number, p: Vec2) => (P[i][j - j0] = p);
  let err = 0;
  set(0, j0, [0, 0]);
  set(0, j0 + 1, [dist(0, j0, 0, j0 + 1), 0]);
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < L - 1; i++) {
      // triangle 1: (i,j) (i,j+1) (i+1,j)
      if (j === j0) {
        set(i + 1, j, place(get(i, j), get(i, j + 1), dist(i, j, i + 1, j), dist(i, j + 1, i + 1, j), i > 0 ? get(i - 1, j + 1) : null));
      } else if (i === 0) {
        set(0, j + 1, place(get(0, j), get(1, j), dist(0, j, 0, j + 1), dist(1, j, 0, j + 1), get(1, j - 1)));
      } else {
        // fully placed already: how far off is the remaining edge? (zero for developable surfaces)
        const a = get(i, j + 1), b = get(i + 1, j);
        const d3 = dist(i, j + 1, i + 1, j);
        if (d3 > 1e-6) err = Math.max(err, Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1]) - d3) / d3);
      }
      // triangle 2: (i+1,j) (i,j+1) (i+1,j+1)
      set(i + 1, j + 1, place(get(i + 1, j), get(i, j + 1), dist(i + 1, j, i + 1, j + 1), dist(i, j + 1, i + 1, j + 1), get(i, j)));
    }
  }
  return { P, err };
}

function dihedral(V: THREE.Vector3[][], j: number): number {
  // angle between the quads either side of ruling j at level 0
  const N = V[0].length;
  const jj = ((j % N) + N) % N;
  const a = V[0][(jj - 1 + N) % N], b = V[0][jj], c = V[0][(jj + 1) % N];
  const up = V[1][jj].clone().sub(b);
  const n1 = b.clone().sub(a).cross(up).normalize();
  const n2 = c.clone().sub(b).cross(up).normalize();
  return (Math.acos(Math.max(-1, Math.min(1, n1.dot(n2)))) * 180) / Math.PI;
}

export function unfold(form: Form | null, v: Values): UnfoldResult {
  const T = v.unfoldThickness;
  const empty = (message: string): UnfoldResult => ({ ok: false, developable: false, maxStretch: 0, message, pieces: [], caps: [], thickness: T });
  if (!form) return empty('No form selected to unroll.');
  if (form.spec.shape === 'mesh') return empty('Imported meshes cannot be unrolled. Slice them into plates or ribs instead.');
  const facets = Math.round(v.unfoldFacets);
  const V = facets >= 3 ? ringsWithCount(form.spec, facets) : form.rings;
  if (!V.length) return empty('Nothing to unroll.');
  const N = V[0].length;
  const k = Math.max(1, Math.min(8, Math.round(v.unfoldPieces)));
  const pieces: UnfoldPiece[] = [];
  let maxErr = 0;
  const R = v.bendRadius;
  const K = v.kFactor;
  let xOff = 0;
  for (let p = 0; p < k; p++) {
    const j0 = Math.round((p * N) / k);
    const j1 = Math.round(((p + 1) * N) / k);
    if (j1 - j0 < 1) continue;
    const { P, err } = unrollColumns(V, j0, j1);
    maxErr = Math.max(maxErr, err);
    const L = V.length;
    const outline: Path = [];
    for (let j = j0; j <= j1; j++) outline.push(P[0][j - j0]);
    for (let i = 1; i < L; i++) outline.push(P[i][j1 - j0]);
    for (let j = j1 - 1; j >= j0; j--) outline.push(P[L - 1][j - j0]);
    for (let i = L - 2; i >= 1; i--) outline.push(P[i][0]);
    // bends: faceted rulings, or any sharp crease
    const bends: Bend[] = [];
    for (let j = j0 + 1; j < j1; j++) {
      const ang = dihedral(V, j);
      // smooth rolls only get a bend line at genuine creases (much sharper than their neighbours)
      const crease = ang > 20 && ang > 2.5 * Math.max(dihedral(V, j - 1), dihedral(V, j + 1), 1);
      if (facets >= 3 ? ang > 0.5 : crease) {
        const th = (ang * Math.PI) / 180;
        const ba = th * (R + K * T);
        const ossb = Math.tan(th / 2) * (R + T);
        bends.push({ angle: ang, ba, bd: 2 * ossb - ba, line: P.map((row) => row[j - j0]) });
      }
    }
    // normalise orientation and position
    if (signedArea(outline) < 0) outline.reverse();
    const bb = bboxOf([outline]);
    const shift = (q: Vec2): Vec2 => [q[0] - bb.minX + xOff, q[1] - bb.minY];
    const o = outline.map(shift);
    bends.forEach((b) => (b.line = b.line.map(shift)));
    const area = Math.abs(signedArea(o));
    const overlaps = Math.abs(shapeArea(union([o])) - area) > area * 0.002 + 1;
    pieces.push({ id: `U-${String(p + 1).padStart(2, '0')}`, outline: o, bends, area, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, overlaps });
    xOff += bb.maxX - bb.minX + 20;
  }
  // flat caps
  const caps: UnfoldPiece[] = [];
  const capFrom = (ring: THREE.Vector3[], id: string) => {
    let o: Path = ring.map((q) => [q.x, -q.z] as Vec2);
    if (signedArea(o) < 0) o = o.reverse();
    const area = Math.abs(signedArea(o));
    if (area < 1) return;
    const bb = bboxOf([o]);
    o = o.map((q) => [q[0] - bb.minX + xOff, q[1] - bb.minY]);
    caps.push({ id, outline: o, bends: [], area, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, overlaps: false });
    xOff += bb.maxX - bb.minX + 20;
  };
  capFrom(V[0], 'U-CAP-BOT');
  capFrom(V[V.length - 1], 'U-CAP-TOP');

  const developable = maxErr < 0.005;
  const pct = (maxErr * 100).toFixed(maxErr < 0.01 ? 2 : 1);
  let message = developable
    ? `Developable: unrolls flat with ${pct}% stretch.`
    : `Double-curved: unrolling needs ${pct}% stretch. Use more facets/pieces, or slice it into plates or ribs instead.`;
  if (pieces.some((q) => q.overlaps)) message += ' Pattern overlaps itself: split it into more pieces.';
  return { ok: true, developable, maxStretch: maxErr, message, pieces, caps, thickness: T };
}
