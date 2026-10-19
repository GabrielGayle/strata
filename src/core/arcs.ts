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

// ---- biarcs ----------------------------------------------------------------
// A smooth stretch of outline is cut as a chain of biarcs: pairs of arcs that meet with
// the same tangent, and each pair leaves with the tangent the next one starts with. The
// laser then never changes direction between entities except at real corners.

/** A vertex turning more than this is a corner: the path keeps its kink there. */
const CORNER = (50 * Math.PI) / 180;
/** ...as long as both its edges are at least this long (mm); past SHARP it is a corner whatever the edges. */
const CORNER_EDGE = 0.5;
const SHARP = (100 * Math.PI) / 180;
/** How far (cosine of the angle) a single arc may land off the path's direction at its end. */
const COS_LAND = Math.cos((3 * Math.PI) / 180);
/** Entities shorter than this (mm) are only cut where nothing longer fits. */
const MIN_SEG = 0.2;
/** Long edges get points this far apart (mm), up to EASE in from each end. */
const DENSE_STEP = 0.5;
const EASE = 2;
/** How far either side of a vertex its tangent is judged from (mm), so 1 µm jitter can't tip it. */
const TANGENT_REACH = 0.6;

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
function unit(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-15 ? [v[0] / l, v[1] / l] : [1, 0];
}

function turnAt(a: Vec2, b: Vec2, c: Vec2): number {
  const u = sub(b, a), w = sub(c, b);
  const lu = Math.hypot(u[0], u[1]), lw = Math.hypot(w[0], w[1]);
  if (lu < 1e-12 || lw < 1e-12) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(u, w) / (lu * lw))));
}

/** One arc (or a line) from p leaving along unit tangent t and ending at q; null when q lies behind p. */
function arcFrom(p: Vec2, t: Vec2, q: Vec2): Seg | null {
  const d = sub(q, p);
  const dd = dot(d, d);
  if (dd < 1e-18) return null;
  const along = dot(d, t);
  const n: Vec2 = [-t[1], t[0]];
  const side = dot(d, n);
  if (Math.abs(side) * RMAX * 2 < dd) return along > 0 ? { kind: 'line', a: p, b: q } : null;
  const s = dd / (2 * side);
  const c: Vec2 = [p[0] + n[0] * s, p[1] + n[1] * s];
  let sweep = Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(p[1] - c[1], p[0] - c[0]);
  if (s > 0) while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  return { kind: 'arc', a: p, b: q, c, r: Math.abs(s), sweep };
}

function endTangent(s: Seg): Vec2 {
  if (s.kind === 'line') return unit(sub(s.b, s.a));
  const rx = s.b[0] - s.c[0], ry = s.b[1] - s.c[1];
  return unit(s.sweep > 0 ? [-ry, rx] : [ry, -rx]);
}

function reverseSeg(s: Seg): Seg {
  return s.kind === 'line' ? { kind: 'line', a: s.b, b: s.a } : { ...s, a: s.b, b: s.a, sweep: -s.sweep };
}

/** The biarc from p0 (tangent t0) to p1 (tangent t1), joined where both arcs share a tangent. */
function biarc(p0: Vec2, t0: Vec2, p1: Vec2, t1: Vec2): Seg[] | null {
  const v = sub(p1, p0);
  const vv = dot(v, v);
  if (vv < 1e-18) return null;
  const t: Vec2 = [t0[0] + t1[0], t0[1] + t1[1]];
  const vt = dot(v, t);
  const denom = 2 * (1 - dot(t0, t1));
  let d: number;
  if (denom < 1e-12) {
    const vt1 = dot(v, t1);
    if (vt1 < 1e-12) return null;
    d = vv / (4 * vt1);
  } else d = (-vt + Math.sqrt(vt * vt + denom * vv)) / denom;
  if (!(d > 0)) return null;
  const m: Vec2 = [(p0[0] + p1[0] + d * (t0[0] - t1[0])) / 2, (p0[1] + p1[1] + d * (t0[1] - t1[1])) / 2];
  const s0 = arcFrom(p0, t0, m);
  const back = arcFrom(p1, [-t1[0], -t1[1]], m);
  if (!s0 || !back) return null;
  const s1 = reverseSeg(back);
  // at most a half circle per arc keeps every DXF bulge within ±1
  for (const s of [s0, s1]) if (s.kind === 'arc' && Math.abs(s.sweep) > Math.PI + 1e-9) return null;
  return [s0, s1];
}

function segLength(s: Seg): number {
  return s.kind === 'line' ? Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) : Math.abs(s.sweep) * s.r;
}

function pointOn(s: Seg, u: number): Vec2 {
  if (s.kind === 'line') return [s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u];
  const a = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]) + s.sweep * u;
  return [s.c[0] + Math.cos(a) * s.r, s.c[1] + Math.sin(a) * s.r];
}

function distToSeg(px: number, py: number, s: Seg): number {
  if (s.kind === 'line') return segDist([px, py], s.a, s.b);
  // inside the arc's wedge the distance is off the radius; outside it, to the nearer end.
  // Arcs never pass a half circle, so two cross products settle the wedge.
  const vx = px - s.c[0], vy = py - s.c[1];
  const ax = s.a[0] - s.c[0], ay = s.a[1] - s.c[1], bx = s.b[0] - s.c[0], by = s.b[1] - s.c[1];
  const sg = s.sweep > 0 ? 1 : -1;
  if ((ax * vy - ay * vx) * sg >= 0 && (vx * by - vy * bx) * sg >= 0) return Math.abs(Math.hypot(vx, vy) - s.r);
  return Math.min(Math.hypot(px - s.a[0], py - s.a[1]), Math.hypot(px - s.b[0], py - s.b[1]));
}

/**
 * Does the curve stay within `tol` of P[i..j] both ways? Every vertex and chord midpoint
 * must sit near the curve, and points along the curve must sit near the polyline (so it
 * can't bulge between vertices or loop away), and its length must match.
 */
function curveFits(P: Path, cum: Float64Array, i: number, j: number, segs: Seg[], tol: number): boolean {
  // cheap tests first: length, then a few points along the curve, then every vertex
  const polyLen = cum[j] - cum[i];
  let curveLen = 0;
  for (const s of segs) curveLen += segLength(s);
  if (curveLen > polyLen * 1.03 + tol) return false;
  let before = 0;
  for (const s of segs) {
    const len = segLength(s);
    if (!(s.kind === 'line' && j - i === 1)) {
      for (const u of CURVE_PROBES) {
        const q = pointOn(s, u);
        // start from the polyline edge at the same share of the length and look outward
        const target = cum[i] + (polyLen * (before + u * len)) / (curveLen || 1);
        let lo = i, hi = j - 1;
        while (lo < hi) {
          const m = (lo + hi + 1) >> 1;
          if (cum[m] <= target) lo = m;
          else hi = m - 1;
        }
        let best = Infinity;
        for (let d = 0; best > tol && (lo - d >= i || lo + d < j); d++) {
          if (lo - d >= i) best = Math.min(best, segDist(q, P[lo - d], P[lo - d + 1]));
          if (d && lo + d < j) best = Math.min(best, segDist(q, P[lo + d], P[lo + d + 1]));
        }
        if (best > tol) return false;
      }
    }
    before += len;
  }
  const near = (x: number, y: number) => {
    for (const s of segs) if (distToSeg(x, y, s) <= tol) return true;
    return false;
  };
  for (let k = i; k < j; k++) {
    const a = P[k], b = P[k + 1];
    if (k > i && !near(a[0], a[1])) return false;
    if (!near((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) return false;
  }
  return true;
}

const CURVE_PROBES = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];

/** Collapse a biarc to one arc or line when its halves are really the same curve. */
function simplifyPair(segs: Seg[]): Seg[] {
  const [s0, s1] = segs;
  if (s0.kind === 'line' && s1.kind === 'line') {
    const u = unit(sub(s0.b, s0.a)), w = unit(sub(s1.b, s1.a));
    if (dot(u, w) > 1 - 1e-10) return [{ kind: 'line', a: s0.a, b: s1.b }];
  }
  if (s0.kind === 'arc' && s1.kind === 'arc') {
    const same = Math.abs(s0.r - s1.r) < 1e-6 * Math.max(1, s0.r) && Math.sign(s0.sweep) === Math.sign(s1.sweep);
    if (same && Math.abs(s0.sweep + s1.sweep) <= Math.PI + 1e-9) return [{ ...s0, b: s1.b, sweep: s0.sweep + s1.sweep }];
  }
  return segs;
}

/** Unit tangent at P[k], from the circle through points about TANGENT_REACH either side (never across a corner). */
function smoothTangent(P: Path, k: number, closed: boolean, corner: boolean[]): Vec2 {
  const n = P.length - 1;
  const at = (x: number) => P[closed ? ((x % n) + n) % n : x];
  const walk = (dir: 1 | -1): Vec2 => {
    let x = k, run = 0;
    for (;;) {
      const nx = x + dir;
      if (!closed && (nx < 0 || nx > n)) break;
      if (closed && Math.abs(nx - k) >= n) break;
      run += Math.hypot(at(nx)[0] - at(x)[0], at(nx)[1] - at(x)[1]);
      x = nx;
      if (run >= TANGENT_REACH || corner[((x % n) + n) % n]) break;
    }
    return at(x);
  };
  const a = walk(-1), b = P[k], c = walk(1);
  const chord = unit(sub(c, a));
  const circ = circleFrom3(a, b, c);
  if (!circ || circ.r > RMAX) return chord;
  const rad = sub(b, circ.c);
  let t = unit([-rad[1], rad[0]]);
  if (dot(t, chord) < 0) t = [-t[0], -t[1]];
  return t;
}

/** Fit an open or closed polyline with tangent-continuous arcs (and lines). Closed paths return a closed chain. */
export function fitArcs(path: Path, tol: number, closed = true): Seg[] {
  // drop points a hair from the last one: Clipper's 1 µm grid leaves micron steps whose
  // direction is noise, and a tangent judged from them would kink the cut
  const near = Math.min(0.01, tol / 5);
  const src: Path = [];
  for (const p of path) {
    const q = src[src.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > near) src.push(p);
  }
  while (closed && src.length > 1) {
    const a = src[0], b = src[src.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > near) break;
    src.pop();
  }
  if (src.length < 2) return [];
  // long straight edges get extra points a millimetre in from each end, so a curve can ease
  // onto a straight instead of having to kink where they meet
  const dense: Path = [];
  for (let k = 0; k < src.length; k++) {
    const a = src[k];
    dense.push(a);
    if (!closed && k === src.length - 1) break;
    const b = src[(k + 1) % src.length];
    // only near its ends: the middle of a straight needs no points to be cut straight
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const at: number[] = [];
    if (len > 2 * DENSE_STEP) for (let d = DENSE_STEP; d < len / 2 && d <= EASE; d += DENSE_STEP) at.push(d / len);
    else if (len > DENSE_STEP) at.push(0.5);
    for (let k = 0, m = at.length; k < m; k++) if (at[m - 1 - k] < 0.5) at.push(1 - at[m - 1 - k]);
    for (const u of at) dense.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  src.splice(0, src.length, ...dense);
  let P: Path;
  if (closed) {
    const s = sharpestIndex(src);
    P = [...src.slice(s), ...src.slice(0, s), src[s]];
  } else P = src;
  const n = P.length - 1;
  if (closed && n < 3) return P.slice(0, n).map((a, i) => ({ kind: 'line', a, b: P[i + 1] }));

  // corners keep their kink; everywhere else the path is smooth
  const corner: boolean[] = new Array(n + 1).fill(false);
  // A big turn between short edges is a tight curve sampled coarsely (a 0.3 mm round from
  // Clipper turns ~50° a vertex), not a corner; calling it one would chop it into stubs.
  const isCorner = (a: Vec2, b: Vec2, c: Vec2) => {
    const turn = turnAt(a, b, c);
    if (turn > SHARP) return true;
    return turn > CORNER && Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1])) >= CORNER_EDGE;
  };
  for (let k = 0; k <= n; k++) {
    if (closed) corner[k] = isCorner(P[(k - 1 + n) % n], P[k % n], P[(k + 1) % n]);
    else corner[k] = k === 0 || k === n || isCorner(P[k - 1], P[k], P[k + 1]);
  }
  const edgeDir = (k: number): Vec2 => unit(sub(P[k + 1], P[k]));
  const tIn: Vec2[] = [], tOut: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    if (corner[k % (closed ? n : n + 1)]) {
      tIn[k] = k > 0 ? edgeDir(k - 1) : closed ? edgeDir(n - 1) : edgeDir(0);
      tOut[k] = k < n ? edgeDir(k) : closed ? edgeDir(0) : edgeDir(n - 1);
    } else tIn[k] = tOut[k] = smoothTangent(P, closed ? k % n : k, closed, corner);
  }

  // keep a fifth of the budget back for whoever re-tessellates the arcs (DXF readers, previews)
  const fitTol = tol * 0.8;
  const cum = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) cum[k] = cum[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
  const out: Seg[] = [];
  /** The longest stretch from i that `make` covers within tol: gallop out, then bisect back. */
  /** `from`: only worth having if it reaches at least that far. */
  const longest = (i: number, hard: number, make: (j: number) => (Seg[] | null)[], minSeg: number, from = 0): { j: number; segs: Seg[] } | null => {
    let good = i, fit: Seg[] | null = null, bad = hard + 1;
    const tryJ = (j: number) => {
      for (const segs of make(j)) if (segs && segs.every((q) => segLength(q) >= minSeg) && curveFits(P, cum, i, j, segs, fitTol)) return segs;
      return null;
    };
    let first = i + 1;
    if (from > i) {
      first = from;
      fit = tryJ(first);
    } else {
      // the first few points one by one (a short first step may be too short on its own), then gallop
      for (let run = 0; first <= hard; first++) {
        run += Math.hypot(P[first][0] - P[first - 1][0], P[first][1] - P[first - 1][1]);
        fit = tryJ(first);
        if (fit || run > 4 * minSeg || first === hard) break;
      }
    }
    if (!fit) return null;
    good = first;
    for (let step = 1, j = first; j < hard; ) {
      j = Math.min(hard, first + (step *= 2) - 1);
      const f = tryJ(j);
      if (!f) {
        bad = j;
        break;
      }
      good = j;
      fit = f;
    }
    while (bad - good > 1 && fit) {
      const mid = (good + bad) >> 1;
      const f = tryJ(mid);
      if (f) {
        good = mid;
        fit = f;
      } else bad = mid;
    }
    return fit ? { j: good, segs: fit } : null;
  };
  let i = 0;
  let t0 = tOut[0];
  while (i < n) {
    // never span a corner
    let hard = i + 1;
    while (hard < n && !corner[hard] && hard - i < MAX_RUN) hard++;
    // one arc leaving along the current tangent, or a biarc that also lands on the next tangent;
    // whichever reaches further (a single arc on a tie: fewer, longer entities)
    // (a single arc must also leave close to the path's own direction, or the next stretch
    // starts askew and has to spend a stub turning back)
    const arcTo = (j: number, land: boolean) => {
      const s = arcFrom(P[i], t0, P[j]);
      if (!s || (s.kind === 'arc' && Math.abs(s.sweep) > Math.PI + 1e-9)) return [null];
      const lands = !land || corner[j] || j === n || dot(endTangent(s), tIn[j]) > COS_LAND;
      return [lands ? [s] : null];
    };
    const makeOne = (j: number) => arcTo(j, true);
    const makeTwo = (j: number) => [biarc(P[i], t0, P[j], tIn[j])];
    // stubs are a last resort: the laser slows for every entity, and short ones show as facets
    let two = longest(i, hard, makeTwo, MIN_SEG);
    let one = longest(i, hard, makeOne, MIN_SEG, two?.j ?? 0);
    // then one arc that lands a little askew, before anything short
    if (!one && !two) one = longest(i, hard, (j) => arcTo(j, false), MIN_SEG);
    if (!one && !two) {
      one = longest(i, hard, makeOne, 0);
      two = longest(i, hard, makeTwo, 0);
    }
    const fit = one && (!two || one.j >= two.j) ? one : two;
    if (!fit) {
      // nothing smooth fits even one step: a corner the turn test missed, cut straight
      out.push({ kind: 'line', a: P[i], b: P[i + 1] });
      i++;
      t0 = corner[i] || i === n ? tOut[i] : edgeDir(i - 1);
      continue;
    }
    const segs = fit === one ? fit.segs : simplifyPair(fit.segs);
    out.push(...segs);
    i = fit.j;
    t0 = corner[i] || i === n ? tOut[i] : endTangent(segs[segs.length - 1]);
  }
  return mergeRuns(out, tol);
}

/** Join neighbouring lines that run straight on, and arcs that continue the same circle. */
function mergeRuns(segs: Seg[], tol: number): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.kind === 'line' && s.kind === 'line') {
      const u = unit(sub(p.b, p.a)), w = unit(sub(s.b, s.a));
      if (dot(u, w) > 1 - 1e-10 && segDist(p.b, p.a, s.b) <= tol / 4) {
        out[out.length - 1] = { kind: 'line', a: p.a, b: s.b };
        continue;
      }
    }
    if (p && p.kind === 'arc' && s.kind === 'arc' && Math.sign(p.sweep) === Math.sign(s.sweep)) {
      const sameCircle = Math.abs(p.r - s.r) < 1e-6 * Math.max(1, p.r) && Math.hypot(p.c[0] - s.c[0], p.c[1] - s.c[1]) < 1e-6 * Math.max(1, p.r);
      if (sameCircle && Math.abs(p.sweep + s.sweep) <= Math.PI + 1e-9) {
        out[out.length - 1] = { ...p, b: s.b, sweep: p.sweep + s.sweep };
        continue;
      }
    }
    out.push(s);
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
