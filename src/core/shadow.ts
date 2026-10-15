// Shadow carving: holes cut through a stack of parallel plates so the sun,
// at chosen times of day, casts chosen pictures onto a screen: a wall behind
// the piece, the ground behind it, or the top of the concrete.
//
// Light reaches a point on the screen only where the ray from it toward the sun
// passes through an opening in every plate. So for each lit pixel of a frame
// we trace back toward where the sun will be at that frame's time and open the
// plate wherever the ray crosses it (on both faces, so thick plates stay open
// at a slant). One frame's holes line up into tunnels that open only while
// the sun sits at that angle.
import type { Values } from './params';
import type { Part, SliceResult } from './slicer';
import type { Plane, V3 } from './section';
import { sample, marchingSquares, type Gray } from './image';
import { bboxOf, clipLines, difference, offset, shapeArea, shapePerimeter, simplifyShape, union, type Shape, type Vec2 } from './geom2d';
import { stackFrame } from './heightfield';
import { siteOf, sunPosition, sunTimes, sunVector } from './sun';

/** One picture in the project, with when it should appear. */
export interface ShadowFrame {
  id: string;
  name: string;
  dataUrl: string;
  /** Clock time (hours) the picture is sharpest. */
  time: number;
  /** Minutes it is held for, centred on its time (0 = an instant). */
  hold: number;
}

export interface ShadowSpec {
  frames: ShadowFrame[];
}

/** A frame as the carver reads it. */
export interface ShadowInput {
  gray: Gray;
  time: number;
  hold: number;
}

export type ScreenKind = 'wall' | 'ground' | 'base';

/** The screen and the picture rectangle on it. */
export interface ShadowGeom {
  screen: ScreenKind;
  /** Unit stack direction (world x, z): the wall faces back along it. */
  s: [number, number];
  /** Unit "right" on the screen, as seen from the front of the piece (world x, z). */
  right: [number, number];
  /** Position of the wall along the stack (world, dot with s); for the ground and concrete, the back plate's face. */
  wallS: number;
  /** World point of screen coordinates (0, 0), and the screen's axes: a runs right, b up the picture. */
  o: V3;
  A: V3;
  B: V3;
  /** Picture rectangle in screen coordinates: left edge, bottom, size, cell. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  cell: number;
  cols: number;
  rows: number;
  /** Side by side: the columns each frame's picture takes (null: every frame uses them all). */
  slots: { c0: number; cols: number }[] | null;
  /** The concrete block (centred on the origin), which shades the ground and is the screen for "base". */
  base: { l: number; w: number; h: number } | null;
}

/** One carved plate as a grid, for previews and scoring. */
export interface PlateGrid {
  key: string;
  plane: Plane;
  thickness: number;
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  /** 1 where the plate blocks light after carving. */
  block: Uint8Array;
}

export interface FrameScore {
  time: number;
  /** Share of the picture that comes out right (intersection over union of lit areas). */
  match: number;
  /** Share of the picture's dark area that is lit by mistake. */
  stray: number;
  /** Why the frame can't show, if it can't. */
  problem: string | null;
  /** What is holding it back, when most of its light is blocked by steel that can't be cut. */
  hint?: string | null;
}

export interface ShadowReport {
  geom: ShadowGeom;
  grids: PlateGrid[];
  /** What each frame should look like on the screen (1 = lit), cols × rows, row 0 at the bottom. */
  targets: Uint8Array[];
  /** 1 where the picture rectangle is real screen (not inside the concrete or a plate). */
  valid: Uint8Array;
  scores: FrameScore[];
  /** Share of the carvable steel cut away. */
  removed: number;
  /** Bits that would have fallen out: held by bridges, or cut away when bridges are off. */
  islands: number;
  /** How many of those were held by bridges. */
  bridged: number;
  plates: number;
  /** Plates that actually got cut. */
  cut: number;
  ms: number;
}

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Even-odd scanline fill of a shape into a node grid (node centres at x0 + c·cell). */
function fillShape(shape: Shape, x0: number, y0: number, cell: number, cols: number, rows: number, out: Uint8Array) {
  const paths = shape.flatMap((ex) => [ex.outer, ...ex.holes]);
  const xs: number[] = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * cell;
    xs.length = 0;
    for (const p of paths) {
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const [ax, ay] = p[j];
        const [bx, by] = p[i];
        if (ay > y !== by > y) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - x0) / cell));
      const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - x0) / cell));
      for (let c = c0; c <= c1; c++) out[r * cols + c] ^= 1;
    }
  }
}

/**
 * Shrink a mask by n nodes sideways only. The plate's sides keep a solid rim;
 * the top edge may be notched, since low sun reaches the far plates over their tops.
 */
function erodeSides(m: Uint8Array, cols: number, rows: number, n: number): Uint8Array {
  let cur = m;
  for (let k = 0; k < n; k++) {
    const nx = new Uint8Array(cur.length);
    for (let r = 0; r < rows; r++)
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        nx[i] = cur[i] & cur[i - 1] & cur[i + 1];
      }
    cur = nx;
  }
  return cur;
}

/**
 * The frames' picture rectangles on the screen. Side by side, `times` places
 * each frame where its own light comes straight through the middle of the
 * stack, so the sun's swing sets the spacing.
 */
export function shadowGeom(v: Values, plates: { plane: Plane; thickness: number }[], times: number[] = []): ShadowGeom {
  const f = stackFrame(v);
  const s: [number, number] = [f.stack[0], f.stack[1]];
  const right: [number, number] = [-s[1], s[0]];
  let back = -Infinity;
  for (const p of plates) back = Math.max(back, p.plane.origin[0] * s[0] + p.plane.origin[2] * s[1] + p.thickness / 2);
  if (!Number.isFinite(back)) back = f.stackLen / 2;
  const cell = Math.max(0.5, Number(v.shadowCell) || 3);
  const pc = Math.max(1, Math.round(Math.max(cell * 4, Number(v.shadowW) || 0) / cell));
  const rows = Math.max(1, Math.round(Math.max(cell * 4, Number(v.shadowH) || 0) / cell));
  const screen: ScreenKind = v.shadowScreen === 'ground' || v.shadowScreen === 'base' ? v.shadowScreen : 'wall';
  const gap = Number(v.shadowGap) || 0;
  const base = v.baseOn ? { l: Number(v.baseLength) || 0, w: Number(v.baseWidth) || 0, h: Number(v.baseHeight) || 0 } : null;
  const A: V3 = [right[0], 0, right[1]];
  const wallS = screen === 'wall' ? back + Math.max(0, gap) : back;
  // wall: b is height above the ground; ground and concrete: b runs back along the stack from the middle
  const o: V3 = screen === 'wall' ? [s[0] * wallS, 0, s[1] * wallS] : [0, screen === 'base' ? (base?.h ?? 0) : 0, 0];
  const B: V3 = screen === 'wall' ? [0, 1, 0] : [s[0], 0, s[1]];
  const y0 = screen === 'wall' ? Number(v.shadowY) || 0 : back + gap;
  const cx = Number(v.shadowX) || 0;
  // side by side: shift each picture across so the ray from its centre crosses the stack's middle (a = 0, along = 0)
  const along = screen === 'wall' ? wallS : y0 + (rows * cell) / 2;
  const site = siteOf(v);
  const offs =
    v.shadowExec === 'side' && times.length > 1
      ? times.map((t) => {
          const pos = sunPosition(site, t);
          const L = sunVector(v, pos);
          const sl = L[0] * s[0] + L[2] * s[1];
          if (pos.elevation <= 1 || sl >= -0.02) return 0;
          return (along / sl) * (L[0] * A[0] + L[2] * A[2]);
        })
      : [0];
  const lefts = offs.map((d) => Math.round((cx + d) / cell - pc / 2));
  const c0 = Math.min(...lefts);
  const cols = Math.max(...lefts) - c0 + pc;
  return {
    screen,
    s,
    right,
    wallS,
    o,
    A,
    B,
    x0: c0 * cell,
    y0,
    w: cols * cell,
    h: rows * cell,
    cell,
    cols,
    rows,
    slots: offs.length > 1 ? lefts.map((l) => ({ c0: l - c0, cols: pc })) : null,
    base,
  };
}

/** World position of a point on the screen: a along "right", b up the picture. */
export function wallPoint(g: ShadowGeom, a: number, b: number): V3 {
  return [g.o[0] + g.A[0] * a + g.B[0] * b, g.o[1] + g.A[1] * a + g.B[1] * b, g.o[2] + g.A[2] * a + g.B[2] * b];
}

/** Is this screen point real screen? Not inside the concrete (ground), and on the concrete but not in a plate (base). */
export function onScreen(g: ShadowGeom, plates: { plane: Plane; thickness: number }[], P: V3): boolean {
  if (g.screen === 'wall' || !g.base) return true;
  const inBase = Math.abs(P[0]) < g.base.l / 2 && Math.abs(P[2]) < g.base.w / 2;
  if (g.screen === 'ground') return !inBase;
  if (!inBase) return false;
  for (const p of plates) {
    const o = p.plane.origin;
    const d = (P[0] - o[0]) * p.plane.normal[0] + (P[1] - o[1]) * p.plane.normal[1] + (P[2] - o[2]) * p.plane.normal[2];
    if (Math.abs(d) < p.thickness / 2) return false;
  }
  return true;
}

/** Does the sun reach this screen point's face at all (before any plate)? */
function facesSun(g: ShadowGeom, L: V3): boolean {
  return g.screen === 'wall' ? -(L[0] * g.s[0] + L[2] * g.s[1]) > 0.02 : L[1] > 0.02;
}

/**
 * A frame's picture laid into the picture rectangle (contain fit), 1 = should be lit.
 * `slot` limits it to one side-by-side patch; the rest stays dark.
 */
export function frameTarget(g: ShadowGeom, gray: Gray, threshold: number, invert: boolean, slot?: { c0: number; cols: number } | null): Uint8Array {
  const out = new Uint8Array(g.cols * g.rows);
  const c0 = slot?.c0 ?? 0;
  const sc = slot?.cols ?? g.cols;
  const aspect = gray.w / gray.h;
  const boxAspect = sc / g.rows;
  // picture size inside the box, as fractions of the box
  const fw = aspect > boxAspect ? 1 : aspect / boxAspect;
  const fh = aspect > boxAspect ? boxAspect / aspect : 1;
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < sc; c++) {
      const bx = (c + 0.5) / sc;
      const by = (r + 0.5) / g.rows;
      const fx = (bx - (1 - fw) / 2) / fw;
      const fy = 1 - (by - (1 - fh) / 2) / fh; // image row 0 is its top
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
      let b = sample(gray, fx, fy);
      if (gray.alpha) b *= sample({ ...gray, data: gray.alpha }, fx, fy);
      out[r * g.cols + c0 + c] = b > threshold !== invert ? 1 : 0;
    }
  return out;
}

interface Carving {
  part: Part[];
  plane: Plane;
  t: number;
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  solid: Uint8Array;
  carvable: Uint8Array;
  hole: Uint8Array;
  bottom: number; // rows below this are under the base top
}

/** For each plate face the ray from P toward L crosses (ahead of P), the node it lands on (or -1 off the grid). */
function* hits(cv: Carving, P: V3, L: V3): Generator<number> {
  const n = cv.plane.normal;
  const ln = dot3(L, n);
  if (Math.abs(ln) < 1e-6) return;
  const o = cv.plane.origin;
  for (const w of [-cv.t / 2, cv.t / 2]) {
    const tHit = ((o[0] + n[0] * w - P[0]) * n[0] + (o[1] + n[1] * w - P[1]) * n[1] + (o[2] + n[2] * w - P[2]) * n[2]) / ln;
    if (tHit < 0) continue;
    const H: V3 = [P[0] + L[0] * tHit - o[0], P[1] + L[1] * tHit - o[1], P[2] + L[2] * tHit - o[2]];
    const c = Math.round((dot3(H, cv.plane.u) - cv.x0) / cv.cell);
    const r = Math.round((dot3(H, cv.plane.v) - cv.y0) / cv.cell);
    yield c < 0 || r < 0 || c >= cv.cols || r >= cv.rows ? -1 : r * cv.cols + c;
  }
}

/** Does a ray from P toward L pass through the concrete block? */
function hitsBase(base: ShadowGeom['base'], P: V3, L: V3): boolean {
  if (!base) return false;
  const lo: V3 = [-base.l / 2, 0, -base.w / 2];
  const hi: V3 = [base.l / 2, base.h, base.w / 2];
  let t0 = 1e-3;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(L[k]) < 1e-9) {
      if (P[k] <= lo[k] || P[k] >= hi[k]) return false;
      continue;
    }
    let a = (lo[k] - P[k]) / L[k];
    let b = (hi[k] - P[k]) / L[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 >= t1) return false;
  }
  return true;
}

/** Is a ray from screen point P toward the sun L blocked by any plate or the concrete? */
function blocked(grids: PlateGrid[], base: ShadowGeom['base'], P: V3, L: V3): boolean {
  for (const g of grids) {
    const n = g.plane.normal;
    const ln = dot3(L, n);
    if (Math.abs(ln) < 1e-6) continue;
    const o = g.plane.origin;
    for (const w of [-g.thickness / 2, g.thickness / 2]) {
      const tHit = ((o[0] + n[0] * w - P[0]) * n[0] + (o[1] + n[1] * w - P[1]) * n[1] + (o[2] + n[2] * w - P[2]) * n[2]) / ln;
      if (tHit < 0) continue;
      const H: V3 = [P[0] + L[0] * tHit - o[0], P[1] + L[1] * tHit - o[1], P[2] + L[2] * tHit - o[2]];
      const c = Math.round((dot3(H, g.plane.u) - g.x0) / g.cell);
      const r = Math.round((dot3(H, g.plane.v) - g.y0) / g.cell);
      if (c >= 0 && r >= 0 && c < g.cols && r < g.rows && g.block[r * g.cols + c]) return true;
    }
  }
  return hitsBase(base, P, L);
}

/** Does a ray from P toward L cross any plate's outline (carved or not)? Light that misses every plate can't be shaped. */
function throughPlates(cvs: Carving[], P: V3, L: V3): boolean {
  for (const cv of cvs) for (const i of hits(cv, P, L)) if (i >= 0 && cv.solid[i]) return true;
  return false;
}

/**
 * Light on the screen at a clock time: 1 where sunlit, 2 where the grid is off the
 * screen (inside the concrete or a plate). The grid covers the picture rectangle
 * grown by `margin` cells each side.
 */
export function renderWall(v: Values, rep: ShadowReport, time: number, margin = 0): { lit: Uint8Array; cols: number; rows: number; up: boolean } {
  const g = rep.geom;
  const cols = g.cols + margin * 2;
  const rows = g.rows + margin * 2;
  const lit = new Uint8Array(cols * rows);
  const pos = sunPosition(siteOf(v), time);
  const L = sunVector(v, pos);
  const up = pos.elevation > 0 && facesSun(g, L);
  const plates = rep.grids.map((p) => ({ plane: p.plane, thickness: p.thickness }));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const P = wallPoint(g, g.x0 + (c - margin + 0.5) * g.cell, g.y0 + (r - margin + 0.5) * g.cell);
      if (!onScreen(g, plates, P)) lit[r * cols + c] = 2;
      else if (up && !blocked(rep.grids, g.base, P, L)) lit[r * cols + c] = 1;
    }
  return { lit, cols, rows, up };
}

/**
 * Sample times for a frame: every minute across its hold (widened toward its
 * neighbours' times by the crossfade), or every 10 minutes all day.
 */
function sampleTimes(v: Values, f: ShadowInput, allDay: boolean, prev: number | null, next: number | null): number[] {
  if (allDay) {
    const t = sunTimes(siteOf(v));
    const a = (t.rise ?? 6) + 0.33;
    const b = (t.set ?? 18) - 0.33;
    const out: number[] = [];
    for (let x = a; x <= b; x += 1 / 6) out.push(x);
    return out;
  }
  const half = Math.max(0, f.hold) / 120;
  let lo = f.time - half;
  let hi = f.time + half;
  const fade = Math.min(1, Math.max(0, (Number(v.shadowFade) || 0) / 100));
  if (fade > 0) {
    const before = prev !== null ? f.time - prev : next !== null ? next - f.time : 0;
    const after = next !== null ? next - f.time : before;
    lo = Math.min(lo, f.time - fade * before);
    hi = Math.max(hi, f.time + fade * after);
  }
  const n = Math.min(121, Math.max(1, Math.round((hi - lo) * 60) + 1));
  if (n === 1) return [f.time];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

/**
 * Hold loose islands in with bridges: the shortest run of cut cells from each
 * island to steel that is still attached, widened to `width` cells. Returns
 * the islands it couldn't reach (left for cutting away).
 */
function bridgeIslands(cv: Carving, keep: Uint8Array, islands: number[][], width: number): number[][] {
  const { cols, solid, hole } = cv;
  const n = solid.length;
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) (seen[i] = 1), queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const c = i % cols;
    for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
      if (j < 0 || j >= n || seen[j] || !solid[j] || !hole[j]) continue;
      seen[j] = 1;
      prev[j] = i;
      queue.push(j);
    }
  }
  const lo = -Math.floor((width - 1) / 2);
  const hi = Math.ceil((width - 1) / 2);
  const rows = cv.rows;
  const left: number[][] = [];
  for (const cells of islands) {
    // the reachable cut cell next to the island that the search got to first is the nearest
    let best = -1;
    let bestRank = Infinity;
    const rank = new Map<number, number>();
    for (const i of cells) {
      const c = i % cols;
      for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
        if (j < 0 || j >= n || !hole[j] || !seen[j]) continue;
        let k = rank.get(j);
        if (k === undefined) {
          // path length back to attached steel
          k = 0;
          for (let x = j; prev[x] >= 0; x = prev[x]) k++;
          rank.set(j, k);
        }
        if (k < bestRank) (bestRank = k), (best = j);
      }
    }
    if (best < 0) {
      left.push(cells);
      continue;
    }
    for (let x = best; x >= 0 && hole[x]; x = prev[x]) {
      const r0 = Math.floor(x / cols);
      const c0 = x % cols;
      for (let dr = lo; dr <= hi; dr++)
        for (let dc = lo; dc <= hi; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const k = r * cols + c;
          if (solid[k]) hole[k] = 0;
        }
    }
  }
  return left;
}

/** Is a ray from P toward L blocked by any carving's remaining steel or the concrete? */
function blockedNow(cvs: Carving[], base: ShadowGeom['base'], P: V3, L: V3): boolean {
  for (const cv of cvs) for (const i of hits(cv, P, L)) if (i >= 0 && cv.solid[i] && !cv.hole[i]) return true;
  return hitsBase(base, P, L);
}

/**
 * Does a loose island do any work? It does when, at some frame's time, it is
 * the only steel keeping sun off a pixel that should be dark. Islands sitting
 * inside lit tunnels only spoil the picture, so those are cut away even when
 * bridges are on.
 */
function islandMatters(cells: number[], cv: Carving, cvs: Carving[], g: ShadowGeom, valid: Uint8Array, looks: { L: V3; target: Uint8Array }[]): boolean {
  const N: V3 = [g.A[1] * g.B[2] - g.A[2] * g.B[1], g.A[2] * g.B[0] - g.A[0] * g.B[2], g.A[0] * g.B[1] - g.A[1] * g.B[0]];
  const { plane } = cv;
  let need = Math.min(2, cells.length);
  for (const k of cells) cv.hole[k] = 1; // as if cut away
  try {
    for (const k of cells) {
      const X: V3 = [0, 0, 0];
      const u = cv.x0 + (k % cv.cols) * cv.cell;
      const w = cv.y0 + Math.floor(k / cv.cols) * cv.cell;
      for (let d = 0; d < 3; d++) X[d] = plane.origin[d] + plane.u[d] * u + plane.v[d] * w;
      for (const { L, target } of looks) {
        // back along the ray from this bit of steel to the screen
        const ln = dot3(L, N);
        if (Math.abs(ln) < 1e-6) continue;
        const lam = ((X[0] - g.o[0]) * N[0] + (X[1] - g.o[1]) * N[1] + (X[2] - g.o[2]) * N[2]) / ln;
        if (lam <= 0) continue;
        const P: V3 = [X[0] - L[0] * lam, X[1] - L[1] * lam, X[2] - L[2] * lam];
        const rel: V3 = [P[0] - g.o[0], P[1] - g.o[1], P[2] - g.o[2]];
        const c = Math.floor((dot3(rel, g.A) - g.x0) / g.cell);
        const r = Math.floor((dot3(rel, g.B) - g.y0) / g.cell);
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const i = r * g.cols + c;
        if (!valid[i] || target[i]) continue;
        const Pc = wallPoint(g, g.x0 + (c + 0.5) * g.cell, g.y0 + (r + 0.5) * g.cell);
        if (!blockedNow(cvs, g.base, Pc, L) && --need <= 0) return true;
      }
    }
    return false;
  } finally {
    for (const k of cells) cv.hole[k] = 0;
  }
}

/** Cut the frames' tunnels into the parallel plates. Returns the carved plates and a report. */
export function carveShadow(v: Values, sliced: SliceResult, frames: ShadowInput[]): { sliced: SliceResult; report: ShadowReport } {
  const t0 = performance.now();
  const allDay = v.shadowExec === 'allday';
  const use = allDay ? frames.slice(0, 1) : frames;
  const cell = Math.max(0.5, Number(v.shadowCell) || 3);
  const rim = Math.max(0, Number(v.shadowRim) || 0);
  const site = siteOf(v);

  // 1. each parallel plate as a grid
  const carvings: Carving[] = [];
  for (const info of sliced.plates) {
    if (info.def.family !== 'P' || !info.parts.length) continue;
    const parts = info.parts;
    const bb = bboxOf(parts.flatMap((p) => p.shape.map((ex) => ex.outer)));
    const x0 = bb.minX - cell;
    const y0 = bb.minY - cell;
    const cols = Math.ceil((bb.maxX - bb.minX) / cell) + 3;
    const rows = Math.ceil((bb.maxY - bb.minY) / cell) + 3;
    const solid = new Uint8Array(cols * rows);
    for (const p of parts) fillShape(p.shape, x0, y0, cell, cols, rows, solid);
    // keep a solid rim up each side, and everything below the base top plus a rim
    const bottom = Math.max(0, Math.ceil((rim - y0) / cell));
    const carvable = erodeSides(solid, cols, rows, Math.ceil(rim / cell));
    for (let r = 0; r < Math.min(rows, bottom); r++) carvable.fill(0, r * cols, (r + 1) * cols);
    carvings.push({ part: parts, plane: parts[0].plane, t: parts[0].thickness, x0, y0, cell, cols, rows, solid, carvable, hole: new Uint8Array(cols * rows), bottom });
  }

  const plates = carvings.map((c) => ({ plane: c.plane, thickness: c.t }));
  const geom = shadowGeom(v, plates, use.map((f) => f.time));
  const valid = new Uint8Array(geom.cols * geom.rows);
  for (let r = 0; r < geom.rows; r++)
    for (let c = 0; c < geom.cols; c++) valid[r * geom.cols + c] = onScreen(geom, plates, wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell)) ? 1 : 0;
  const threshold = Number(v.shadowThreshold);
  const targets = use.map((f, fi) => {
    const t = frameTarget(geom, f.gray, Number.isFinite(threshold) ? threshold : 0.5, !!v.shadowInvert, geom.slots?.[fi] ?? null);
    for (let i = 0; i < t.length; i++) t[i] &= valid[i];
    return t;
  });
  const problems: (string | null)[] = use.map(() => null);
  const hints: (string | null)[] = use.map(() => null);
  const byTime = use.map((f) => f.time).sort((a, b) => a - b);

  // 2. open the plates along every lit pixel's ray, for every sample time
  use.forEach((f, fi) => {
    let usable = 0;
    let missing = 0;
    let lit = 0;
    const k = byTime.indexOf(f.time);
    const prev = k > 0 ? byTime[k - 1] : null;
    const next = k >= 0 && k < byTime.length - 1 ? byTime[k + 1] : null;
    const tgt = targets[fi];
    for (const time of sampleTimes(v, f, allDay, prev, next)) {
      const pos = sunPosition(site, time);
      const L = sunVector(v, pos);
      if (pos.elevation <= 1 || !facesSun(geom, L)) continue;
      usable++;
      for (let r = 0; r < geom.rows; r++)
        for (let c = 0; c < geom.cols; c++) {
          if (!tgt[r * geom.cols + c]) continue;
          const P = wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell);
          for (const cv of carvings) for (const i of hits(cv, P, L)) if (i >= 0 && cv.carvable[i]) cv.hole[i] = 1;
        }
    }
    if (!usable) {
      problems[fi] =
        sunPosition(site, f.time).elevation <= 1
          ? 'The sun is down at this time.'
          : geom.screen === 'wall'
            ? 'The sun is behind the wall at this time: it must shine on the front of the piece.'
            : 'The sun is too low to reach the screen at this time.';
      return;
    }
    // light that misses every plate can't be shaped, and light that must pass uncut steel can't get through
    const L = sunVector(v, sunPosition(site, f.time));
    let want = 0;
    let stuck = 0;
    for (let r = 0; r < geom.rows; r++)
      for (let c = 0; c < geom.cols; c++) {
        const i = r * geom.cols + c;
        const slot = geom.slots?.[fi];
        if (!valid[i] || (slot && (c < slot.c0 || c >= slot.c0 + slot.cols))) continue;
        lit++;
        const P = wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell);
        const inBase = hitsBase(geom.base, P, L);
        if (!inBase && !throughPlates(carvings, P, L)) missing++;
        if (!tgt[i]) continue;
        want++;
        if (inBase || carvings.some((cv) => [...hits(cv, P, L)].some((k) => k >= 0 && cv.solid[k] && !cv.carvable[k]))) stuck++;
      }
    if (lit && missing / lit > 0.5) problems[fi] = 'At this time most of the sun reaching the picture misses the plates. Move the picture or the screen so the light comes through the plates.';
    else if (want && stuck / want > 0.5)
      hints[fi] = geom.screen === 'wall' ? 'Most of this picture\'s light would have to pass the uncut rim at the plates\' sides or bottom. Move the picture, or lower the Solid rim.' : 'Most of this picture\'s light would have to pass the concrete or the uncut rim low on the plates. Move the picture further back, or lower the Solid rim.';
  });

  // 3. anything cut loose would fall out: hold it in with bridges, or cut it away
  const bridgeW = Math.max(0, Number(v.shadowBridge) || 0);
  let islands = 0;
  let bridged = 0;
  // what each frame should look like at its own time (all day: on the hour), to judge loose bits by
  const looks: { L: V3; target: Uint8Array }[] = [];
  use.forEach((f, fi) => {
    const times = allDay ? sampleTimes(v, f, true, null, null).filter((_, i) => i % 6 === 0) : [f.time];
    for (const t of times) {
      const pos = sunPosition(site, t);
      const L = sunVector(v, pos);
      if (pos.elevation > 1 && facesSun(geom, L)) looks.push({ L, target: targets[fi] });
    }
  });
  let carved = 0;
  let carvableTotal = 0;
  for (const cv of carvings) {
    const { cols, rows, solid, hole } = cv;
    const attached = () => {
      const keep = new Uint8Array(cols * rows);
      const stack: number[] = [];
      for (let i = 0; i < cols * Math.min(rows, cv.bottom + 1); i++) if (solid[i] && !hole[i]) (keep[i] = 1), stack.push(i);
      while (stack.length) {
        const i = stack.pop()!;
        const c = i % cols;
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
          if (j < 0 || j >= keep.length || keep[j] || !solid[j] || hole[j]) continue;
          keep[j] = 1;
          stack.push(j);
        }
      }
      return keep;
    };
    const loose = (keep: Uint8Array) => {
      const out: number[][] = [];
      const seen = new Uint8Array(cols * rows);
      for (let i = 0; i < keep.length; i++) {
        if (!solid[i] || hole[i] || keep[i] || seen[i]) continue;
        const cells: number[] = [];
        const st = [i];
        seen[i] = 1;
        while (st.length) {
          const k = st.pop()!;
          cells.push(k);
          const c = k % cols;
          for (const j of [c > 0 ? k - 1 : -1, c < cols - 1 ? k + 1 : -1, k - cols, k + cols])
            if (j >= 0 && j < keep.length && !seen[j] && solid[j] && !hole[j] && !keep[j]) (seen[j] = 1), st.push(j);
        }
        out.push(cells);
      }
      return out;
    };
    let keep = attached();
    let found = loose(keep);
    islands += found.length;
    if (bridgeW > 0 && found.length) {
      // only islands that keep light off dark parts of a picture are worth a bridge
      const useful = found.filter((cells) => islandMatters(cells, cv, carvings, geom, valid, looks));
      found = found.filter((cells) => !useful.includes(cells)).concat(bridgeIslands(cv, keep, useful, Math.max(1, Math.ceil(bridgeW / cell - 1e-6))));
      keep = attached();
      // a bridge can't be drawn if nothing reaches it; anything still loose is cut away below
      const unreached = loose(keep);
      bridged += useful.length - unreached.filter((cells) => useful.some((u) => u.includes(cells[0]))).length;
      found = unreached;
    }
    for (const cells of found) for (const k of cells) hole[k] = 1;
    for (let i = 0; i < hole.length; i++) {
      if (cv.carvable[i]) carvableTotal++;
      if (hole[i] && cv.carvable[i]) carved++;
    }
  }
  const cutAway = islands - bridged;

  // 4. cut the holes into the parts
  const replaced = new Map<Part, Part>();
  for (const cv of carvings) {
    if (!cv.hole.some(Boolean)) continue;
    const field = new Float32Array(cv.cols * cv.rows);
    for (let i = 0; i < field.length; i++) field[i] = cv.hole[i] ? 1 : -1;
    const loops = marchingSquares(field, cv.cols, cv.rows).map((l) => l.map(([x, y]) => [cv.x0 + x * cv.cell, cv.y0 + y * cv.cell] as Vec2));
    if (!loops.length) continue;
    const holes = simplifyShape(union(loops, 'evenodd'), cv.cell * 0.12);
    for (const p of cv.part) {
      const cut = difference(p.shape, holes).filter((ex) => (ex.depth ?? 0) === 0);
      if (!cut.length) continue;
      const ex = cut.reduce((a, b) => (shapeArea([b]) > shapeArea([a]) ? b : a));
      replaced.set(p, {
        ...p,
        shape: [ex],
        etch: p.etch.length ? clipLines(p.etch, offset([ex], -0.8)) : p.etch,
        area: shapeArea([ex]),
        perimeter: shapePerimeter([ex]),
        bbox: bboxOf([ex.outer]),
      });
    }
  }

  const grids: PlateGrid[] = carvings.map((cv) => {
    const block = new Uint8Array(cv.solid.length);
    for (let i = 0; i < block.length; i++) block[i] = cv.solid[i] && !cv.hole[i] ? 1 : 0;
    return { key: cv.part[0].plateKey, plane: cv.plane, thickness: cv.t, x0: cv.x0, y0: cv.y0, cell: cv.cell, cols: cv.cols, rows: cv.rows, block };
  });
  const report: ShadowReport = { geom, grids, targets, valid, scores: [], removed: carvableTotal ? carved / carvableTotal : 0, islands, bridged, plates: carvings.length, cut: carvings.filter((cv) => cv.hole.some((h, i) => h && cv.carvable[i])).length, ms: 0 };

  // 5. how well each frame comes out
  report.scores = use.map((f, fi) => {
    const tgt = targets[fi];
    if (problems[fi]) return { time: f.time, match: 0, stray: 0, problem: problems[fi] };
    const { lit } = renderWall(v, report, f.time);
    let both = 0, either = 0, stray = 0, dark = 0;
    for (let i = 0; i < tgt.length; i++) {
      if (!valid[i]) continue;
      const on = lit[i] === 1;
      if (on && tgt[i]) both++;
      if (on || tgt[i]) either++;
      if (!tgt[i]) {
        dark++;
        if (on) stray++;
      }
    }
    return { time: f.time, match: either ? both / either : 1, stray: dark ? stray / dark : 0, problem: null, hint: hints[fi] };
  });

  const swap = (p: Part) => replaced.get(p) ?? p;
  const out: SliceResult = replaced.size
    ? { ...sliced, plates: sliced.plates.map((pl) => (pl.parts.some((p) => replaced.has(p)) ? { ...pl, parts: pl.parts.map(swap) } : pl)), parts: sliced.parts.map(swap) }
    : sliced;
  if (cutAway) out.warnings = [...sliced.warnings, `Shadow carve: ${cutAway} loose bit(s) inside the cut-outs were cut away so nothing falls out.`];
  report.ms = performance.now() - t0;
  return { sliced: out, report };
}

/** Frames as saved in a project file, cleaned up. */
export function cleanShadow(raw: unknown): ShadowSpec | undefined {
  const r = raw as { frames?: unknown } | null;
  if (!r || !Array.isArray(r.frames)) return undefined;
  const frames: ShadowFrame[] = [];
  for (const f of r.frames as any[]) {
    if (!f || typeof f.dataUrl !== 'string') continue;
    frames.push({
      id: typeof f.id === 'string' ? f.id : `f${frames.length + 1}`,
      name: typeof f.name === 'string' ? f.name : `Frame ${frames.length + 1}`,
      dataUrl: f.dataUrl,
      time: Number.isFinite(f.time) ? Math.min(24, Math.max(0, f.time)) : 12,
      hold: Number.isFinite(f.hold) ? Math.min(240, Math.max(0, f.hold)) : 0,
    });
  }
  return frames.length ? { frames } : undefined;
}
