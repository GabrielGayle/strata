// Shadow carving: holes cut through a stack of parallel plates so the sun,
// at chosen times of day, casts chosen pictures onto a wall behind the piece.
//
// Light reaches a point on the wall only where the ray from it toward the sun
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

/** The wall and the picture rectangle on it. */
export interface ShadowGeom {
  /** Unit stack direction (world x, z): the wall faces back along it. */
  s: [number, number];
  /** Unit "right" on the wall, as seen from the front of the piece (world x, z). */
  right: [number, number];
  /** Position of the wall along the stack (world, dot with s). */
  wallS: number;
  /** Picture rectangle: left edge (along right), bottom (height above ground), size, cell. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  cell: number;
  cols: number;
  rows: number;
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
}

export interface ShadowReport {
  geom: ShadowGeom;
  grids: PlateGrid[];
  /** What each frame should look like on the wall (1 = lit), cols × rows, row 0 at the bottom. */
  targets: Uint8Array[];
  scores: FrameScore[];
  /** Share of the carvable steel cut away. */
  removed: number;
  /** Bits that would have fallen out, cut away instead. */
  islands: number;
  plates: number;
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

export function shadowGeom(v: Values, plates: { plane: Plane; thickness: number }[]): ShadowGeom {
  const f = stackFrame(v);
  const s: [number, number] = [f.stack[0], f.stack[1]];
  const right: [number, number] = [-s[1], s[0]];
  let back = -Infinity;
  for (const p of plates) back = Math.max(back, p.plane.origin[0] * s[0] + p.plane.origin[2] * s[1] + p.thickness / 2);
  if (!Number.isFinite(back)) back = f.stackLen / 2;
  const cell = Math.max(0.5, Number(v.shadowCell) || 3);
  const w = Math.max(cell * 4, Number(v.shadowW) || 0);
  const h = Math.max(cell * 4, Number(v.shadowH) || 0);
  return {
    s,
    right,
    wallS: back + Math.max(0, Number(v.shadowGap) || 0),
    x0: (Number(v.shadowX) || 0) - w / 2,
    y0: Number(v.shadowY) || 0,
    w,
    h,
    cell,
    cols: Math.max(1, Math.round(w / cell)),
    rows: Math.max(1, Math.round(h / cell)),
  };
}

/** World position of a point on the wall: a along "right", y up. */
export function wallPoint(g: ShadowGeom, a: number, y: number): V3 {
  return [g.s[0] * g.wallS + g.right[0] * a, y, g.s[1] * g.wallS + g.right[1] * a];
}

/** A frame's picture laid into the picture rectangle (contain fit), 1 = should be lit. */
export function frameTarget(g: ShadowGeom, gray: Gray, threshold: number, invert: boolean): Uint8Array {
  const out = new Uint8Array(g.cols * g.rows);
  const aspect = gray.w / gray.h;
  const boxAspect = g.w / g.h;
  // picture size inside the box, as fractions of the box
  const fw = aspect > boxAspect ? 1 : aspect / boxAspect;
  const fh = aspect > boxAspect ? boxAspect / aspect : 1;
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const bx = (c + 0.5) / g.cols;
      const by = (r + 0.5) / g.rows;
      const fx = (bx - (1 - fw) / 2) / fw;
      const fy = 1 - (by - (1 - fh) / 2) / fh; // image row 0 is its top
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
      let b = sample(gray, fx, fy);
      if (gray.alpha) b *= sample({ ...gray, data: gray.alpha }, fx, fy);
      out[r * g.cols + c] = b > threshold !== invert ? 1 : 0;
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

/** For each plate face, the node a ray from P along L lands on (or -1). */
function* hits(cv: Carving, P: V3, L: V3): Generator<number> {
  const n = cv.plane.normal;
  const ln = dot3(L, n);
  if (Math.abs(ln) < 1e-6) return;
  const o = cv.plane.origin;
  for (const w of [-cv.t / 2, cv.t / 2]) {
    const tHit = ((o[0] + n[0] * w - P[0]) * n[0] + (o[1] + n[1] * w - P[1]) * n[1] + (o[2] + n[2] * w - P[2]) * n[2]) / ln;
    const H: V3 = [P[0] + L[0] * tHit - o[0], P[1] + L[1] * tHit - o[1], P[2] + L[2] * tHit - o[2]];
    const c = Math.round((dot3(H, cv.plane.u) - cv.x0) / cv.cell);
    const r = Math.round((dot3(H, cv.plane.v) - cv.y0) / cv.cell);
    yield c < 0 || r < 0 || c >= cv.cols || r >= cv.rows ? -1 : r * cv.cols + c;
  }
}

/** Is a ray from wall point P toward the sun L blocked by any plate? */
function blocked(grids: PlateGrid[], P: V3, L: V3): boolean {
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
  return false;
}

/**
 * Light on the wall at a clock time: 1 where sunlit. The grid covers the
 * picture rectangle grown by `margin` cells each side.
 */
export function renderWall(v: Values, rep: ShadowReport, time: number, margin = 0): { lit: Uint8Array; cols: number; rows: number; up: boolean } {
  const g = rep.geom;
  const cols = g.cols + margin * 2;
  const rows = g.rows + margin * 2;
  const lit = new Uint8Array(cols * rows);
  const pos = sunPosition(siteOf(v), time);
  const L = sunVector(v, pos);
  // the wall faces back along the stack: sunlight must come from the front
  const facing = -(L[0] * g.s[0] + L[2] * g.s[1]);
  if (pos.elevation <= 0 || facing <= 0) return { lit, cols, rows, up: false };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const P = wallPoint(g, g.x0 + (c - margin + 0.5) * g.cell, g.y0 + (r - margin + 0.5) * g.cell);
      if (!blocked(rep.grids, P, L)) lit[r * cols + c] = 1;
    }
  return { lit, cols, rows, up: true };
}

/** Sample times for a frame: every minute across its hold, or every 10 minutes all day. */
function sampleTimes(v: Values, f: ShadowInput, allDay: boolean): number[] {
  if (allDay) {
    const t = sunTimes(siteOf(v));
    const a = (t.rise ?? 6) + 0.33;
    const b = (t.set ?? 18) - 0.33;
    const out: number[] = [];
    for (let x = a; x <= b; x += 1 / 6) out.push(x);
    return out;
  }
  const n = Math.max(1, Math.round(Math.max(0, f.hold)) + 1);
  if (n === 1) return [f.time];
  return Array.from({ length: n }, (_, i) => f.time + ((i / (n - 1) - 0.5) * f.hold) / 60);
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

  const geom = shadowGeom(v, carvings.map((c) => ({ plane: c.plane, thickness: c.t })));
  const threshold = Number(v.shadowThreshold);
  const targets = use.map((f) => frameTarget(geom, f.gray, Number.isFinite(threshold) ? threshold : 0.5, !!v.shadowInvert));
  const problems: (string | null)[] = use.map(() => null);

  // 2. open the plates along every lit pixel's ray, for every sample time
  use.forEach((f, fi) => {
    let usable = 0;
    for (const time of sampleTimes(v, f, allDay)) {
      const pos = sunPosition(site, time);
      const L = sunVector(v, pos);
      if (pos.elevation <= 1 || -(L[0] * geom.s[0] + L[2] * geom.s[1]) <= 0.02) continue;
      usable++;
      const tgt = targets[fi];
      for (let r = 0; r < geom.rows; r++)
        for (let c = 0; c < geom.cols; c++) {
          if (!tgt[r * geom.cols + c]) continue;
          const P = wallPoint(geom, geom.x0 + (c + 0.5) * cell, geom.y0 + (r + 0.5) * cell);
          for (const cv of carvings) for (const i of hits(cv, P, L)) if (i >= 0 && cv.carvable[i]) cv.hole[i] = 1;
        }
    }
    if (!usable) problems[fi] = sunPosition(site, f.time).elevation <= 1 ? 'The sun is down at this time.' : 'The sun is behind the wall at this time: it must shine on the front of the piece.';
  });

  // 3. anything cut loose would fall out: cut it away too
  let islands = 0;
  let carved = 0;
  let carvableTotal = 0;
  for (const cv of carvings) {
    const { cols, rows, solid, hole } = cv;
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
    const seen = new Uint8Array(cols * rows);
    for (let i = 0; i < keep.length; i++) {
      if (!solid[i] || hole[i] || keep[i] || seen[i]) continue;
      islands++;
      const st = [i];
      seen[i] = 1;
      while (st.length) {
        const k = st.pop()!;
        hole[k] = 1;
        const c = k % cols;
        for (const j of [c > 0 ? k - 1 : -1, c < cols - 1 ? k + 1 : -1, k - cols, k + cols])
          if (j >= 0 && j < keep.length && !seen[j] && solid[j] && !hole[j] && !keep[j]) (seen[j] = 1), st.push(j);
      }
    }
    for (let i = 0; i < hole.length; i++) {
      if (cv.carvable[i]) carvableTotal++;
      if (hole[i] && cv.carvable[i]) carved++;
    }
  }

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
  const report: ShadowReport = { geom, grids, targets, scores: [], removed: carvableTotal ? carved / carvableTotal : 0, islands, plates: carvings.length, ms: 0 };

  // 5. how well each frame comes out
  report.scores = use.map((f, fi) => {
    const tgt = targets[fi];
    if (problems[fi]) return { time: f.time, match: 0, stray: 0, problem: problems[fi] };
    const { lit } = renderWall(v, report, f.time);
    let both = 0, either = 0, stray = 0, dark = 0;
    for (let i = 0; i < tgt.length; i++) {
      if (lit[i] && tgt[i]) both++;
      if (lit[i] || tgt[i]) either++;
      if (!tgt[i]) {
        dark++;
        if (lit[i]) stray++;
      }
    }
    return { time: f.time, match: either ? both / either : 1, stray: dark ? stray / dark : 0, problem: null };
  });

  const swap = (p: Part) => replaced.get(p) ?? p;
  const out: SliceResult = replaced.size
    ? { ...sliced, plates: sliced.plates.map((pl) => (pl.parts.some((p) => replaced.has(p)) ? { ...pl, parts: pl.parts.map(swap) } : pl)), parts: sliced.parts.map(swap) }
    : sliced;
  if (islands) out.warnings = [...sliced.warnings, `Shadow carve: ${islands} loose bit(s) inside the cut-outs were cut away so nothing falls out.`];
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
