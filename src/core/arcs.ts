// Convert dense polylines into lines + true arcs within a tolerance, so the
// laser gets smooth curves without splines.
import type { Path, Vec2 } from './geom2d';

export type Seg =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; a: Vec2; b: Vec2; c: Vec2; r: number; sweep: number }; // sweep > 0 = CCW (radians)

const RMAX = 20000;

function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function lineFits(P: Path, i: number, j: number, tol: number): boolean {
  for (let k = i + 1; k < j; k++) if (segDist(P[k], P[i], P[j]) > tol) return false;
  return true;
}

function arcFit(P: Path, i: number, j: number, tol: number): { c: Vec2; r: number; sweep: number } | null {
  if (j - i < 3) return null;
  const m = (i + j) >> 1;
  const circ = circleFrom3(P[i], P[m], P[j]);
  if (!circ || circ.r > RMAX) return null;
  const { c, r } = circ;
  let sweep = 0;
  let prev = Math.atan2(P[i][1] - c[1], P[i][0] - c[0]);
  let sign = 0;
  for (let k = i + 1; k <= j; k++) {
    if (Math.abs(Math.hypot(P[k][0] - c[0], P[k][1] - c[1]) - r) > tol) return null;
    const ang = Math.atan2(P[k][1] - c[1], P[k][0] - c[0]);
    let d = ang - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const s = Math.sign(d);
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return null;
    }
    sweep += d;
    prev = ang;
  }
  if (Math.abs(sweep) > Math.PI * 1.98 || Math.abs(sweep) < 1e-4) return null;
  return { c, r, sweep };
}

function sharpestIndex(P: Path): number {
  let best = 0, bestTurn = -1;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - b[0], by = c[1] - b[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    if (turn > bestTurn) {
      bestTurn = turn;
      best = i;
    }
  }
  return best;
}

const MAX_RUN = 400;

/** Fit an open or closed polyline with lines and arcs. Closed paths return a closed chain. */
export function fitArcs(path: Path, tol: number, closed = true): Seg[] {
  if (path.length < 2) return [];
  let P: Path;
  if (closed) {
    const s = sharpestIndex(path);
    P = [...path.slice(s), ...path.slice(0, s), path[s]];
  } else P = path;
  const n = P.length - 1;
  const out: Seg[] = [];
  let i = 0;
  while (i < n) {
    let jl = i + 1;
    while (jl + 1 <= n && jl + 1 - i <= MAX_RUN && lineFits(P, i, jl + 1, tol)) jl++;
    let ja = -1;
    let arc: { c: Vec2; r: number; sweep: number } | null = null;
    for (let j = i + 3; j <= n && j - i <= MAX_RUN; j++) {
      const f = arcFit(P, i, j, tol);
      if (!f) break;
      ja = j;
      arc = f;
    }
    if (arc && ja > jl) {
      out.push({ kind: 'arc', a: P[i], b: P[ja], c: arc.c, r: arc.r, sweep: arc.sweep });
      i = ja;
    } else {
      out.push({ kind: 'line', a: P[i], b: P[jl] });
      i = jl;
    }
  }
  return out;
}

/** Re-sample segments back into points (for previews and verification). */
export function segsToPath(segs: Seg[], maxStep = 2): Path {
  const out: Path = [];
  for (const s of segs) {
    if (s.kind === 'line') {
      out.push(s.a);
    } else {
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
      const n = Math.max(2, Math.ceil((Math.abs(s.sweep) * s.r) / maxStep));
      for (let k = 0; k < n; k++) {
        const a = a0 + (s.sweep * k) / n;
        out.push([s.c[0] + Math.cos(a) * s.r, s.c[1] + Math.sin(a) * s.r]);
      }
    }
  }
  return out;
}

export function countArcs(segs: Seg[]): { lines: number; arcs: number } {
  let lines = 0, arcs = 0;
  for (const s of segs) s.kind === 'arc' ? arcs++ : lines++;
  return { lines, arcs };
}
