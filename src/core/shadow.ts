// Shadow carving: holes cut through a stack of parallel plates so the sun,
// at chosen times of day, or a candle in front of the piece casts chosen
// pictures onto a screen: a wall behind the piece, the ground behind it, or
// the top of the concrete.
//
// Light reaches a point on the screen only where the ray from it toward the
// light passes through an opening in every plate. So for every point of every
// plate (on both faces, so thick plates stay open at a slant) we follow the
// light on to the screen and read the picture there: the plate is opened where
// the picture is bright. Reading the picture smoothly, not cell by cell, puts
// the cut edges between grid points, so outlines follow the picture rather
// than the grid. One frame's holes line up into tunnels that open only while
// the sun sits at that angle (a candle's are always open).
import type { Values } from './params';
import type { Part, SliceResult } from './slicer';
import type { Plane, V3 } from './section';
import { sample, marchingSquares, type Gray } from './image';
import { bboxOf, clipLines, difference, offset, shapeArea, shapePerimeter, simplifyShape, union, type Shape, type Vec2 } from './geom2d';
import { stackFrame } from './heightfield';
import { shiftSite, siteOf, sunPosition, sunTimes, sunVector } from './sun';

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

/** Where the light comes from: the sun (a unit direction toward it) or a candle flame (a point). */
export type Light = { dir: V3 } | { at: V3 };

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
  /** The candle flame (world), or null when the sun is the light. */
  candle: V3 | null;
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
  /** The carved plate's outline (plate coordinates), for sharper renders than the grid. */
  shape: Shape;
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
  let front = Infinity;
  for (const p of plates) {
    const at = p.plane.origin[0] * s[0] + p.plane.origin[2] * s[1];
    back = Math.max(back, at + p.thickness / 2);
    front = Math.min(front, at - p.thickness / 2);
  }
  if (!Number.isFinite(back)) back = f.stackLen / 2;
  if (!Number.isFinite(front)) front = -f.stackLen / 2;
  // the candle stands in front of the front plate
  const candle: V3 | null = isCandle(v)
    ? (() => {
        const along = front - Math.max(1, Number(v.candleD) || 0);
        const across = Number(v.candleX) || 0;
        return [s[0] * along + right[0] * across, Math.max(1, Number(v.candleH) || 0), s[1] * along + right[1] * across];
      })()
    : null;
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
    !candle && v.shadowExec === 'side' && times.length > 1
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
    candle,
  };
}

/** Is a candle the light (rather than the sun)? */
export const isCandle = (v: Values) => v.shadowLight === 'candle';

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

/** Does the light reach the screen's face at all (before any plate)? */
function facesLight(g: ShadowGeom, lt: Light): boolean {
  if ('at' in lt) {
    const C = lt.at;
    return g.screen === 'wall' ? C[0] * g.s[0] + C[2] * g.s[1] < g.wallS - 1 : C[1] > (g.screen === 'base' ? (g.base?.h ?? 0) : 0) + 1;
  }
  const L = lt.dir;
  return g.screen === 'wall' ? -(L[0] * g.s[0] + L[2] * g.s[1]) > 0.02 : L[1] > 0.02;
}

/**
 * The light at a clock time, some days from the set date: the sun where it is
 * then, or the candle (always the same). `up` is false when it can't reach the
 * screen at all (the sun is down or behind the wall, the candle behind it).
 */
export function lightAt(v: Values, g: ShadowGeom, time: number, dayOffset = 0): { light: Light; up: boolean } {
  if (g.candle) {
    const light = { at: g.candle };
    return { light, up: facesLight(g, light) };
  }
  const pos = sunPosition(shiftSite(siteOf(v), dayOffset), time);
  const light = { dir: sunVector(v, pos) };
  return { light, up: pos.elevation > 0 && facesLight(g, light) };
}

/** Vector from P toward the light, written into D; returns how far along it the light is (a candle is reached at 1). */
function toward(lt: Light, P: V3, D: V3): number {
  if ('at' in lt) {
    D[0] = lt.at[0] - P[0];
    D[1] = lt.at[1] - P[1];
    D[2] = lt.at[2] - P[2];
    return 1;
  }
  D[0] = lt.dir[0];
  D[1] = lt.dir[1];
  D[2] = lt.dir[2];
  return Infinity;
}

/**
 * Small points across the light's real size, for soft shadows: the sun's disc
 * (half a degree across) or the candle flame (`flame` mm wide, twice as tall).
 */
export function lightSpread(g: ShadowGeom, lt: Light, flame: number, n = 7): Light[] {
  const out: Light[] = [lt];
  const ring = Math.max(0, n - 1);
  for (let k = 0; k < ring; k++) {
    const a = (k / ring) * Math.PI * 2;
    const x = Math.cos(a) * 0.7;
    const y = Math.sin(a) * 0.7;
    if ('at' in lt) {
      const r = flame / 2;
      out.push({ at: [lt.at[0] + g.right[0] * x * r, lt.at[1] + y * r * 2, lt.at[2] + g.right[1] * x * r] });
    } else {
      // two directions square to the sun's
      const L = lt.dir;
      const h = Math.hypot(L[0], L[2]) || 1;
      const e1: V3 = [-L[2] / h, 0, L[0] / h];
      const e2: V3 = [L[1] * e1[2] - L[2] * e1[1], L[2] * e1[0] - L[0] * e1[2], L[0] * e1[1] - L[1] * e1[0]];
      const r = 0.00465; // the sun's radius in radians
      const d: V3 = [L[0] + (e1[0] * x + e2[0] * y) * r, L[1] + (e1[1] * x + e2[1] * y) * r, L[2] + (e1[2] * x + e2[2] * y) * r];
      const m = Math.hypot(...d);
      out.push({ dir: [d[0] / m, d[1] / m, d[2] / m] });
    }
  }
  return out;
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
  thickness: number;
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  solid: Uint8Array;
  carvable: Uint8Array;
  hole: Uint8Array;
  /** Best picture signal the light through each node lands on (> 0: should be open), for smooth cut edges. */
  val: Float32Array;
  bottom: number; // rows below this are under the base top
}

/** A plate laid out as a grid of nodes (carving, carved, or a finer copy for rendering). */
interface Gridded {
  plane: Plane;
  thickness: number;
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
}

/**
 * Where the ray P + D·t (0 ≤ t ≤ tMax) crosses one face of a plate (side −1
 * or +1): the node it lands on, −1 off the grid, or −2 if it doesn't cross.
 */
function cross(g: Gridded, P: V3, D: V3, tMax: number, side: number): number {
  const n = g.plane.normal;
  const ln = D[0] * n[0] + D[1] * n[1] + D[2] * n[2];
  if (Math.abs(ln) < 1e-9) return -2;
  const o = g.plane.origin;
  const w = (side * g.thickness) / 2;
  const t = ((o[0] + n[0] * w - P[0]) * n[0] + (o[1] + n[1] * w - P[1]) * n[1] + (o[2] + n[2] * w - P[2]) * n[2]) / ln;
  if (t < 0 || t > tMax) return -2;
  const hx = P[0] + D[0] * t - o[0];
  const hy = P[1] + D[1] * t - o[1];
  const hz = P[2] + D[2] * t - o[2];
  const u = g.plane.u;
  const vv = g.plane.v;
  const c = Math.round((hx * u[0] + hy * u[1] + hz * u[2] - g.x0) / g.cell);
  const r = Math.round((hx * vv[0] + hy * vv[1] + hz * vv[2] - g.y0) / g.cell);
  return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
}

/** Does the ray P + D·t (0 < t ≤ tMax) pass through the concrete block? */
function hitsBase(base: ShadowGeom['base'], P: V3, D: V3, tMax = Infinity): boolean {
  if (!base) return false;
  const lo: V3 = [-base.l / 2, 0, -base.w / 2];
  const hi: V3 = [base.l / 2, base.h, base.w / 2];
  let t0 = 1e-3;
  let t1 = tMax;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(D[k]) < 1e-9) {
      if (P[k] <= lo[k] || P[k] >= hi[k]) return false;
      continue;
    }
    let a = (lo[k] - P[k]) / D[k];
    let b = (hi[k] - P[k]) / D[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 >= t1) return false;
  }
  return true;
}

/** Is the ray from screen point P toward the light blocked by any plate (grid `block`) or the concrete? */
function blocked(grids: (Gridded & { block: Uint8Array })[], base: ShadowGeom['base'], P: V3, D: V3, tMax: number): boolean {
  for (const g of grids)
    for (let side = -1; side <= 1; side += 2) {
      const i = cross(g, P, D, tMax, side);
      if (i >= 0 && g.block[i]) return true;
    }
  return hitsBase(base, P, D, tMax);
}

/** Does the ray cross any plate's outline (carved or not)? Light that misses every plate can't be shaped. */
function throughPlates(cvs: Carving[], P: V3, D: V3, tMax: number): boolean {
  for (const cv of cvs)
    for (let side = -1; side <= 1; side += 2) {
      const i = cross(cv, P, D, tMax, side);
      if (i >= 0 && cv.solid[i]) return true;
    }
  return false;
}

/**
 * Light on the screen at a clock time: 1 where lit, 2 where the grid is off the
 * screen (inside the concrete or a plate). The grid covers the picture rectangle
 * grown by `margin` cells each side. Coarse (one picture cell per pixel): for scoring.
 */
export function renderWall(v: Values, rep: ShadowReport, time: number, margin = 0, dayOffset = 0): { lit: Uint8Array; cols: number; rows: number; up: boolean } {
  const g = rep.geom;
  const cols = g.cols + margin * 2;
  const rows = g.rows + margin * 2;
  const lit = new Uint8Array(cols * rows);
  const { light, up } = lightAt(v, g, time, dayOffset);
  const plates = rep.grids;
  const D: V3 = [0, 0, 0];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const P = wallPoint(g, g.x0 + (c - margin + 0.5) * g.cell, g.y0 + (r - margin + 0.5) * g.cell);
      if (!onScreen(g, plates, P)) lit[r * cols + c] = 2;
      else if (up && !blocked(rep.grids, g.base, P, D, toward(light, P, D))) lit[r * cols + c] = 1;
    }
  return { lit, cols, rows, up };
}

const fineCache = new WeakMap<PlateGrid, { cell: number; g: Gridded & { block: Uint8Array } }>();

/** A carved plate rasterised from its real outline at a finer cell, for sharp renders. */
function fineGrid(p: PlateGrid, cell: number): Gridded & { block: Uint8Array } {
  const hit = fineCache.get(p);
  if (hit && hit.cell === cell) return hit.g;
  const bb = bboxOf(p.shape.map((ex) => ex.outer));
  const x0 = bb.minX - cell;
  const y0 = bb.minY - cell;
  const cols = Math.max(1, Math.ceil((bb.maxX - bb.minX) / cell) + 3);
  const rows = Math.max(1, Math.ceil((bb.maxY - bb.minY) / cell) + 3);
  const block = new Uint8Array(cols * rows);
  fillShape(p.shape, x0, y0, cell, cols, rows, block);
  const g = { plane: p.plane, thickness: p.thickness, x0, y0, cell, cols, rows, block };
  fineCache.set(p, { cell, g });
  return g;
}

/** A patch of screen to render: `cols` × `rows` pixels of `px` mm from (a0, b0), row 0 at the bottom. */
export interface ScreenView {
  a0: number;
  b0: number;
  px: number;
  cols: number;
  rows: number;
}

/**
 * Light on a patch of screen, traced through the carved plates' real outlines:
 * for each pixel, the share of `lights` that reach it (soft shadows when they
 * spread across the light's size), times how bright the light is there (a
 * candle falls off with distance and angle, normalised to 1 in the middle of
 * the picture). −1 where it is not screen. Renders rows r0 to r1 into `out`.
 */
export function renderScreen(rep: ShadowReport, lights: Light[], view: ScreenView, out: Float32Array, r0 = 0, r1 = view.rows) {
  const g = rep.geom;
  const fine = Math.max(0.25, g.cell / 4);
  const grids = rep.grids.map((p) => fineGrid(p, fine));
  const N: V3 = [g.A[1] * g.B[2] - g.A[2] * g.B[1], g.A[2] * g.B[0] - g.A[0] * g.B[2], g.A[0] * g.B[1] - g.A[1] * g.B[0]];
  const ups = lights.map((lt) => facesLight(g, lt));
  const C = g.candle;
  // brightness reference: the middle of the picture
  const mid = wallPoint(g, g.x0 + g.w / 2, g.y0 + g.h / 2);
  const glow = (P: V3) => {
    if (!C) return 1;
    const d: V3 = [C[0] - P[0], C[1] - P[1], C[2] - P[2]];
    const r2 = dot3(d, d);
    const cos = Math.abs(dot3(d, N)) / Math.sqrt(r2);
    const m: V3 = [C[0] - mid[0], C[1] - mid[1], C[2] - mid[2]];
    const m2 = dot3(m, m);
    const cosM = Math.abs(dot3(m, N)) / Math.sqrt(m2) || 1;
    return (cos / cosM) * (m2 / r2);
  };
  const plates = rep.grids;
  const D: V3 = [0, 0, 0];
  for (let r = r0; r < r1; r++)
    for (let c = 0; c < view.cols; c++) {
      const P = wallPoint(g, view.a0 + (c + 0.5) * view.px, view.b0 + (r + 0.5) * view.px);
      const k = r * view.cols + c;
      if (!onScreen(g, plates, P)) {
        out[k] = -1;
        continue;
      }
      let n = 0;
      for (let j = 0; j < lights.length; j++) if (ups[j] && !blocked(grids, g.base, P, D, toward(lights[j], P, D))) n++;
      out[k] = n ? (n / lights.length) * glow(P) : 0;
    }
}

/** Days either side of the set date the carve is tuned for: evenly spread across the date window. */
export function windowDays(v: Values): number[] {
  const d = Math.max(0, Math.round(Number(v.shadowDays) || 0));
  if (d < 2) return [0];
  const n = Math.min(5, 2 * Math.ceil(d / 10) + 1);
  const at = (x: number) => Math.sign(x) * Math.round(Math.abs(x)); // symmetric about the set date
  return Array.from({ length: n }, (_, i) => at(-d / 2 + (d * i) / (n - 1)));
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
 * Make the cut mask laser-friendly. A cut that is one cell on its own makes a
 * pinhole smaller than the sheet is thick, so it is left solid. Where cuts
 * touch only at a corner, the steel between them comes out as a sliver
 * narrower than the kerf, so the corner is opened up (or, if that steel can't
 * be cut, one of the cuts is closed).
 */
function tidyCuts(cv: Carving) {
  const { cols, rows, solid, carvable, hole } = cv;
  const cut = (i: number) => solid[i] && hole[i];
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c + 1 < cols; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        for (const [p, q, x, y] of [
          [a, e, b, d],
          [b, d, a, e],
        ]) {
          if (!cut(p) || !cut(q) || cut(x) || cut(y) || !solid[x] || !solid[y]) continue;
          if (carvable[x]) hole[x] = 1;
          else if (carvable[y]) hole[y] = 1;
          else hole[q] = 0;
          changed = true;
        }
      }
    if (!changed) break;
  }
  for (let i = 0; i < hole.length; i++) {
    if (!cut(i)) continue;
    const c = i % cols;
    const alone = (c === 0 || !cut(i - 1)) && (c === cols - 1 || !cut(i + 1)) && (i < cols || !cut(i - cols)) && (i + cols >= hole.length || !cut(i + cols));
    if (alone) hole[i] = 0;
  }
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

/** Is the ray from P toward the light blocked by any carving's remaining steel or the concrete? */
function blockedNow(cvs: Carving[], base: ShadowGeom['base'], P: V3, D: V3, tMax: number): boolean {
  for (const cv of cvs)
    for (let side = -1; side <= 1; side += 2) {
      const i = cross(cv, P, D, tMax, side);
      if (i >= 0 && cv.solid[i] && !cv.hole[i]) return true;
    }
  return hitsBase(base, P, D, tMax);
}

/**
 * Where the light through world point X lands on the screen plane, as screen
 * (a, b) and how far on from X (≤ 0: the screen isn't beyond X); null if never.
 */
function toPlane(g: ShadowGeom, N: V3, lt: Light, X: V3): [number, number, number] | null {
  // on from X, away from the light
  const D: V3 = 'at' in lt ? [X[0] - lt.at[0], X[1] - lt.at[1], X[2] - lt.at[2]] : [-lt.dir[0], -lt.dir[1], -lt.dir[2]];
  const dn = dot3(D, N);
  if (Math.abs(dn) < 1e-9) return null;
  const lam = ((g.o[0] - X[0]) * N[0] + (g.o[1] - X[1]) * N[1] + (g.o[2] - X[2]) * N[2]) / dn;
  const rel: V3 = [X[0] + D[0] * lam - g.o[0], X[1] + D[1] * lam - g.o[1], X[2] + D[2] * lam - g.o[2]];
  return [dot3(rel, g.A), dot3(rel, g.B), lam];
}

/** Where the light through world point X lands on the screen, as screen (a, b); null if it doesn't. */
function toScreen(g: ShadowGeom, N: V3, lt: Light, X: V3): [number, number] | null {
  const p = toPlane(g, N, lt, X);
  return p && p[2] > 0 ? [p[0], p[1]] : null;
}

/**
 * Does a loose island do any work? It does when, at some frame's time, it is
 * the only steel keeping sun off a pixel that should be dark. Islands sitting
 * inside lit tunnels only spoil the picture, so those are cut away even when
 * bridges are on.
 */
function islandMatters(cells: number[], cv: Carving, cvs: Carving[], g: ShadowGeom, valid: Uint8Array, looks: { light: Light; target: Uint8Array }[]): boolean {
  const N: V3 = [g.A[1] * g.B[2] - g.A[2] * g.B[1], g.A[2] * g.B[0] - g.A[0] * g.B[2], g.A[0] * g.B[1] - g.A[1] * g.B[0]];
  const { plane } = cv;
  const D: V3 = [0, 0, 0];
  let need = Math.min(2, cells.length);
  for (const k of cells) cv.hole[k] = 1; // as if cut away
  try {
    for (const k of cells) {
      const X: V3 = [0, 0, 0];
      const u = cv.x0 + (k % cv.cols) * cv.cell;
      const w = cv.y0 + Math.floor(k / cv.cols) * cv.cell;
      for (let d = 0; d < 3; d++) X[d] = plane.origin[d] + plane.u[d] * u + plane.v[d] * w;
      for (const { light, target } of looks) {
        // on along the light from this bit of steel to the screen
        const ab = toScreen(g, N, light, X);
        if (!ab) continue;
        const c = Math.floor((ab[0] - g.x0) / g.cell);
        const r = Math.floor((ab[1] - g.y0) / g.cell);
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const i = r * g.cols + c;
        if (!valid[i] || target[i]) continue;
        const Pc = wallPoint(g, g.x0 + (c + 0.5) * g.cell, g.y0 + (r + 0.5) * g.cell);
        if (!blockedNow(cvs, g.base, Pc, D, toward(light, Pc, D)) && --need <= 0) return true;
      }
    }
    return false;
  } finally {
    for (const k of cells) cv.hole[k] = 0;
  }
}

/** How well frame `fi` comes out at a clock time, some days from the set date. */
export function frameMatch(v: Values, rep: ShadowReport, fi: number, time: number, dayOffset = 0): { match: number; stray: number } {
  const tgt = rep.targets[fi];
  const { lit } = renderWall(v, rep, time, 0, dayOffset);
  let both = 0, either = 0, stray = 0, dark = 0;
  for (let i = 0; i < tgt.length; i++) {
    if (!rep.valid[i]) continue;
    const on = lit[i] === 1;
    if (on && tgt[i]) both++;
    if (on || tgt[i]) either++;
    if (!tgt[i]) {
      dark++;
      if (on) stray++;
    }
  }
  return { match: either ? both / either : 1, stray: dark ? stray / dark : 0 };
}

/** A frame's picture as a smooth signal over the picture rectangle (a third of a cell per sample). */
interface Signal {
  data: Float32Array;
  cols: number;
  rows: number;
  px: number;
  /** The brightest it reads anywhere. */
  top: number;
}

/**
 * The picture laid into the picture rectangle like `frameTarget`, but kept
 * smooth: brightness above the threshold (> 0 should be lit), −1 off the
 * picture, outside its side-by-side slot, or where there is no screen.
 */
function pictureSignal(g: ShadowGeom, gray: Gray, threshold: number, invert: boolean, slot: { c0: number; cols: number } | null, valid: Uint8Array): Signal {
  const k = 3;
  const cols = g.cols * k;
  const rows = g.rows * k;
  const data = new Float32Array(cols * rows).fill(-1);
  const c0 = slot?.c0 ?? 0;
  const sc = slot?.cols ?? g.cols;
  const aspect = gray.w / gray.h;
  const boxAspect = sc / g.rows;
  const fw = aspect > boxAspect ? 1 : aspect / boxAspect;
  const fh = aspect > boxAspect ? boxAspect / aspect : 1;
  const alpha = gray.alpha ? { ...gray, data: gray.alpha } : null;
  for (let R = 0; R < rows; R++)
    for (let C = 0; C < cols; C++) {
      if (!valid[Math.floor(R / k) * g.cols + Math.floor(C / k)]) continue;
      const bx = ((C + 0.5) / k - c0) / sc;
      if (bx < 0 || bx > 1) continue;
      const by = (R + 0.5) / k / g.rows;
      const fx = (bx - (1 - fw) / 2) / fw;
      const fy = 1 - (by - (1 - fh) / 2) / fh;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
      let b = sample(gray, fx, fy);
      if (alpha) b *= sample(alpha, fx, fy);
      data[R * cols + C] = invert ? threshold - b : b - threshold;
    }
  let top = -1;
  for (const x of data) if (x > top) top = x;
  return { data, cols, rows, px: g.cell / k, top };
}

/** The picture signal at screen point (a, b), read smoothly; −1 off it. */
function signalAt(sg: Signal, g: ShadowGeom, a: number, b: number): number {
  const x = (a - g.x0) / sg.px - 0.5;
  const y = (b - g.y0) / sg.px - 0.5;
  if (x < -0.5 || y < -0.5 || x > sg.cols - 0.5 || y > sg.rows - 0.5) return -1;
  const cx = Math.min(sg.cols - 1, Math.max(0, x));
  const cy = Math.min(sg.rows - 1, Math.max(0, y));
  const x0 = Math.min(sg.cols - 2, Math.floor(cx));
  const y0 = Math.min(sg.rows - 2, Math.floor(cy));
  if (x0 < 0 || y0 < 0) return sg.data[Math.round(cy) * sg.cols + Math.round(cx)];
  const tx = cx - x0;
  const ty = cy - y0;
  const d = sg.data;
  const i = y0 * sg.cols + x0;
  return (d[i] * (1 - tx) + d[i + 1] * tx) * (1 - ty) + (d[i + sg.cols] * (1 - tx) + d[i + sg.cols + 1] * tx) * ty;
}

/**
 * Open one plate face wherever the light through it lands on a bright part of
 * the picture: for every carvable node of the face, follow the light on to the
 * screen and keep the best signal seen in `val`. Only the nodes whose light can
 * land on the picture rectangle are visited.
 */
function openFace(cv: Carving, side: number, g: ShadowGeom, N: V3, lt: Light, sg: Signal) {
  const { plane, cell, cols, rows } = cv;
  const n = plane.normal;
  const w = (side * cv.thickness) / 2;
  const O: V3 = [plane.origin[0] + n[0] * w, plane.origin[1] + n[1] * w, plane.origin[2] + n[2] * w];
  const node = (u: number, vv: number): V3 => [O[0] + plane.u[0] * u + plane.v[0] * vv, O[1] + plane.u[1] * u + plane.v[1] * vv, O[2] + plane.u[2] * u + plane.v[2] * vv];
  // the picture rectangle's corners, traced back toward the light onto this face, bound the nodes to visit
  let c0 = 0;
  let c1 = cols - 1;
  let r0 = 0;
  let r1 = rows - 1;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  let behind = 0;
  const D: V3 = [0, 0, 0];
  for (const [a, b] of [
    [g.x0, g.y0],
    [g.x0 + g.w, g.y0],
    [g.x0, g.y0 + g.h],
    [g.x0 + g.w, g.y0 + g.h],
  ]) {
    const P = wallPoint(g, a, b);
    const tMax = toward(lt, P, D);
    const dn = dot3(D, n);
    const t = Math.abs(dn) < 1e-9 ? -1 : ((O[0] - P[0]) * n[0] + (O[1] - P[1]) * n[1] + (O[2] - P[2]) * n[2]) / dn;
    if (t < 0 || t > tMax) {
      behind++;
      continue;
    }
    const rel: V3 = [P[0] + D[0] * t - O[0], P[1] + D[1] * t - O[1], P[2] + D[2] * t - O[2]];
    const u = dot3(rel, plane.u);
    const vv = dot3(rel, plane.v);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, vv);
    vMax = Math.max(vMax, vv);
  }
  if (behind === 4) return; // the face isn't between the light and the screen
  if (!behind) {
    c0 = Math.max(0, Math.floor((uMin - cv.x0) / cell) - 1);
    c1 = Math.min(cols - 1, Math.ceil((uMax - cv.x0) / cell) + 1);
    r0 = Math.max(0, Math.floor((vMin - cv.y0) / cell) - 1);
    r1 = Math.min(rows - 1, Math.ceil((vMax - cv.y0) / cell) + 1);
  }
  const { carvable, val } = cv;
  const top = sg.top; // nothing reads brighter, so nodes already there are done
  if ('dir' in lt) {
    // parallel light: the screen point moves in straight, even steps across the face
    const p00 = toPlane(g, N, lt, node(cv.x0, cv.y0));
    const p10 = toPlane(g, N, lt, node(cv.x0 + cell, cv.y0));
    const p01 = toPlane(g, N, lt, node(cv.x0, cv.y0 + cell));
    if (!p00 || !p10 || !p01) return;
    const dac = p10[0] - p00[0], dbc = p10[1] - p00[1], dlc = p10[2] - p00[2];
    const dar = p01[0] - p00[0], dbr = p01[1] - p00[1], dlr = p01[2] - p00[2];
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (!carvable[i] || val[i] >= top || p00[2] + c * dlc + r * dlr <= 0) continue;
        const s = signalAt(sg, g, p00[0] + c * dac + r * dar, p00[1] + c * dbc + r * dbr);
        if (s > val[i]) val[i] = s;
      }
    return;
  }
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      if (!carvable[i] || val[i] >= top) continue;
      const ab = toScreen(g, N, lt, node(cv.x0 + c * cell, cv.y0 + r * cell));
      if (!ab) continue;
      const s = signalAt(sg, g, ab[0], ab[1]);
      if (s > val[i]) val[i] = s;
    }
}

/** Smallest signal an open node gets: keeps cut edges a little way off the nodes, so no hair-thin slivers. */
const OPEN = 0.1;

/** Cut the frames' tunnels into the parallel plates. Returns the carved plates and a report. */
export function carveShadow(v: Values, sliced: SliceResult, frames: ShadowInput[]): { sliced: SliceResult; report: ShadowReport } {
  const t0 = performance.now();
  const candle = isCandle(v);
  const allDay = !candle && v.shadowExec === 'allday';
  // a candle doesn't move, so it shows one picture
  const use = allDay || candle ? frames.slice(0, 1) : frames;
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
    carvings.push({ part: parts, plane: parts[0].plane, thickness: parts[0].thickness, x0, y0, cell, cols, rows, solid, carvable, hole: new Uint8Array(cols * rows), val: new Float32Array(cols * rows).fill(-1), bottom });
  }

  const plates = carvings.map((c) => ({ plane: c.plane, thickness: c.thickness }));
  const geom = shadowGeom(v, plates, use.map((f) => f.time));
  const N: V3 = [geom.A[1] * geom.B[2] - geom.A[2] * geom.B[1], geom.A[2] * geom.B[0] - geom.A[0] * geom.B[2], geom.A[0] * geom.B[1] - geom.A[1] * geom.B[0]];
  const valid = new Uint8Array(geom.cols * geom.rows);
  for (let r = 0; r < geom.rows; r++)
    for (let c = 0; c < geom.cols; c++) valid[r * geom.cols + c] = onScreen(geom, plates, wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell)) ? 1 : 0;
  const thr = Number(v.shadowThreshold);
  const threshold = Number.isFinite(thr) ? thr : 0.5;
  const targets = use.map((f, fi) => {
    const t = frameTarget(geom, f.gray, threshold, !!v.shadowInvert, geom.slots?.[fi] ?? null);
    for (let i = 0; i < t.length; i++) t[i] &= valid[i];
    return t;
  });
  const problems: (string | null)[] = use.map(() => null);
  const hints: (string | null)[] = use.map(() => null);
  const byTime = use.map((f) => f.time).sort((a, b) => a - b);
  const days = candle ? [0] : windowDays(v);
  const D: V3 = [0, 0, 0];

  // 2. open the plates wherever the light through them falls on the bright parts of the picture
  use.forEach((f, fi) => {
    const k = byTime.indexOf(f.time);
    const prev = k > 0 ? byTime[k - 1] : null;
    const next = k >= 0 && k < byTime.length - 1 ? byTime[k + 1] : null;
    // every light to carve for, and the ones (the frame's own time each day) whose rays also open every lit pixel
    const lights: Light[] = [];
    const rays = new Set<Light>();
    if (geom.candle) {
      const lt = { at: geom.candle };
      if (facesLight(geom, lt)) lights.push(lt), rays.add(lt);
    } else {
      const times = sampleTimes(v, f, allDay, prev, next);
      const mid = times.reduce((m, t) => (Math.abs(t - f.time) < Math.abs(m - f.time) ? t : m), times[0]);
      for (const day of days) {
        const siteD = shiftSite(site, day);
        for (const time of times) {
          const pos = sunPosition(siteD, time);
          const lt = { dir: sunVector(v, pos) };
          if (pos.elevation > 1 && facesLight(geom, lt)) {
            lights.push(lt);
            if (allDay || time === mid) rays.add(lt);
          }
        }
      }
    }
    if (!lights.length) {
      problems[fi] = geom.candle
        ? geom.screen === 'wall'
          ? 'The candle is behind the wall: it must stand in front of the piece.'
          : 'The candle is too low to reach the screen: raise its flame.'
        : sunPosition(site, f.time).elevation <= 1
          ? 'The sun is down at this time.'
          : geom.screen === 'wall'
            ? 'The sun is behind the wall at this time: it must shine on the front of the piece.'
            : 'The sun is too low to reach the screen at this time.';
      return;
    }
    const sg = pictureSignal(geom, f.gray, threshold, !!v.shadowInvert, geom.slots?.[fi] ?? null, valid);
    const tgt = targets[fi];
    for (const lt of lights) {
      for (const cv of carvings) for (let side = -1; side <= 1; side += 2) openFace(cv, side, geom, N, lt, sg);
      if (!rays.has(lt)) continue;
      // and every lit pixel's own ray, so features thinner than a cell (or stretched across a slanting screen) still get through
      for (let r = 0; r < geom.rows; r++)
        for (let c = 0; c < geom.cols; c++) {
          if (!tgt[r * geom.cols + c]) continue;
          const P = wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell);
          const tMax = toward(lt, P, D);
          for (const cv of carvings)
            for (let side = -1; side <= 1; side += 2) {
              const i = cross(cv, P, D, tMax, side);
              if (i >= 0 && cv.carvable[i] && cv.val[i] < OPEN) cv.val[i] = OPEN;
            }
        }
    }

    // light that misses every plate can't be shaped, and light that must pass uncut steel can't get through
    const lt: Light = geom.candle ? { at: geom.candle } : { dir: sunVector(v, sunPosition(site, f.time)) };
    let missing = 0;
    let lit = 0;
    let want = 0;
    let stuck = 0;
    for (let r = 0; r < geom.rows; r++)
      for (let c = 0; c < geom.cols; c++) {
        const i = r * geom.cols + c;
        const slot = geom.slots?.[fi];
        if (!valid[i] || (slot && (c < slot.c0 || c >= slot.c0 + slot.cols))) continue;
        lit++;
        const P = wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell);
        const tMax = toward(lt, P, D);
        const inBase = hitsBase(geom.base, P, D, tMax);
        if (!inBase && !throughPlates(carvings, P, D, tMax)) missing++;
        if (!tgt[i]) continue;
        want++;
        if (
          inBase ||
          carvings.some((cv) => {
            for (let side = -1; side <= 1; side += 2) {
              const j = cross(cv, P, D, tMax, side);
              if (j >= 0 && cv.solid[j] && !cv.carvable[j]) return true;
            }
            return false;
          })
        )
          stuck++;
      }
    const mover = geom.candle ? 'the candle' : 'the screen';
    if (lit && missing / lit > 0.5) problems[fi] = `${geom.candle ? 'Most of the candle light' : 'At this time most of the sun'} reaching the picture misses the plates. Move the picture or ${mover} so the light comes through the plates.`;
    else if (want && stuck / want > 0.5)
      hints[fi] =
        geom.screen === 'wall'
          ? `Most of this picture's light would have to pass the uncut rim at the plates' sides or bottom${v.insertOn ? ', or round the insert' : ''}. Move the picture${geom.candle ? ' or the candle' : ''}, or lower the Solid rim.`
          : "Most of this picture's light would have to pass the concrete or the uncut rim low on the plates. Move the picture further back, or lower the Solid rim.";
  });
  for (const cv of carvings) for (let i = 0; i < cv.hole.length; i++) if (cv.carvable[i] && cv.val[i] > 0) cv.hole[i] = 1;

  // tidy the cuts for the laser: no lone pinholes, and no steel joined only at a corner
  for (const cv of carvings) tidyCuts(cv);

  // 3. anything cut loose would fall out: hold it in with bridges, or cut it away
  const bridgeW = Math.max(0, Number(v.shadowBridge) || 0);
  let islands = 0;
  let bridged = 0;
  // what each frame should look like at its own time (all day: on the hour), to judge loose bits by
  const looks: { light: Light; target: Uint8Array }[] = [];
  use.forEach((f, fi) => {
    if (geom.candle) {
      const light = { at: geom.candle };
      if (facesLight(geom, light)) looks.push({ light, target: targets[fi] });
      return;
    }
    const times = allDay ? sampleTimes(v, f, true, null, null).filter((_, i) => i % 6 === 0) : [f.time];
    for (const t of times) {
      const pos = sunPosition(site, t);
      const light = { dir: sunVector(v, pos) };
      if (pos.elevation > 1 && facesLight(geom, light)) looks.push({ light, target: targets[fi] });
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
    // open nodes > 0, closed < 0; where the picture decided, its smooth signal places the edge between nodes
    const field = new Float32Array(cv.cols * cv.rows);
    for (let i = 0; i < field.length; i++) {
      const s = cv.val[i];
      field[i] = cv.hole[i] ? (s > 0 ? Math.min(1, Math.max(OPEN, s)) : 1) : cv.solid[i] && cv.carvable[i] && s <= 0 ? Math.max(-1, Math.min(-OPEN, s)) : -1;
    }
    // a web of steel one node wide between two cuts must stay at least the min feature wide: pull the cut edges back from it
    const half = (Math.max(0, Number(v.minFeature) || 0) / 2) * 1.08;
    if (half > 0) {
      const t = half / cv.cell; // how far from the web node each edge must sit, in cells
      const cap = t < 1 ? Math.max(OPEN, 1 / t - 1) : -1;
      const { cols } = cv;
      const thin: [number, number][] = [];
      for (let i = 0; i < field.length; i++) {
        if (field[i] >= 0 || !cv.solid[i]) continue;
        const c = i % cols;
        if (c > 0 && c < cols - 1 && field[i - 1] > 0 && field[i + 1] > 0) thin.push([i, 1]);
        if (i >= cols && i + cols < field.length && field[i - cols] > 0 && field[i + cols] > 0) thin.push([i, cols]);
      }
      for (const [i, d] of thin) {
        field[i] = -1;
        for (const j of [i - d, i + d]) {
          if (cap < 0 && cv.carvable[j]) cv.hole[j] = 0;
          field[j] = Math.min(field[j], cap);
        }
      }
    }
    // carry cuts that reach the plate's edge out past it, so no sliver of steel is left along the outline
    for (let i = 0; i < field.length; i++) {
      if (!cv.hole[i] || !cv.solid[i]) continue;
      const r = Math.floor(i / cv.cols);
      const c = i % cv.cols;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= cv.rows || cc >= cv.cols) continue;
          const j = rr * cv.cols + cc;
          if (!cv.solid[j]) field[j] = 1;
        }
    }
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
    const shape = cv.part.flatMap((p) => (replaced.get(p) ?? p).shape);
    return { key: cv.part[0].plateKey, plane: cv.plane, thickness: cv.thickness, x0: cv.x0, y0: cv.y0, cell: cv.cell, cols: cv.cols, rows: cv.rows, block, shape };
  });
  const report: ShadowReport = { geom, grids, targets, valid, scores: [], removed: carvableTotal ? carved / carvableTotal : 0, islands, bridged, plates: carvings.length, cut: carvings.filter((cv) => cv.hole.some((h, i) => h && cv.carvable[i])).length, ms: 0 };

  // 5. how well each frame comes out
  report.scores = use.map((f, fi) => {
    if (problems[fi]) return { time: f.time, match: 0, stray: 0, problem: problems[fi] };
    return { time: f.time, ...frameMatch(v, report, fi, f.time), problem: null, hint: hints[fi] };
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
