// The slicer: turns forms + parameters into flat, laser-ready plates.
// Every outline and every cavity is computed per plate in 2D, then extruded
// straight through the sheet, so every edge is cut at 90°.
import type { Values } from './params';
import { cached } from './memo';
import {
  bboxOf,
  circlePath,
  clipLines,
  difference,
  intersection,
  offset,
  pointInShape,
  rect,
  shapeArea,
  shapeBBox,
  shapePerimeter,
  signedArea,
  union,
  unionShapes,
  simplifyShape,
  xor,
  type BBox,
  type ExPoly,
  type Path,
  type Shape,
  type Vec2,
  BIG,
} from './geom2d';
import { offsetPlane, planeToWorld, sectionShape, type Plane, type V3 } from './section';
import { stackFrame, type HeightField } from './heightfield';
import { flatFootprint, flatGrid, flatOutline, flatPinPoints, flatStampCut, outlinePaths, pinFits, type FlatGrid } from './flatstack';
import type { IndexedMesh } from './forms';
import { sightCut, type SightCard } from './sightLine';
import { boxBlur, distanceInside, marchingSquares, sample, type Gray } from './image';
import { strokeTextCentered, textWidth } from './strokefont';
import { MAX_TUNED, MIN_TUNED, tunePlates, tuningActive, type PlateTune } from './tuning';
import { addTenons, baseChamfers, ringShape, supportPlane, supportSpec, type SupportSpec } from './base';
import { buildSpacers, planRods, rodHardware, rodHoles, type BraceIssue, type HardwareRow, type RodPlan, type SpacerResult } from './brace';
import { finishPlatePieces, type FragmentEvent } from './fragments';
import { movePlane, type PartMoves } from './moves';
import {
  applyStackRodSmall,
  applyStackRodWorld,
  clipEtchFromFastenerHoles,
  fastenerDisks,
  LABEL_HOLE_CLEAR_MM,
  pathsHitDisk,
  placeStackRods,
  punchStackRodHoles,
  resolveStackRodStickOut,
  stackRodSettings,
  type StackRodPlan,
} from './stackRods';
import { orientMapPlatePlane } from './mapPlateHeight';
import { MAP_WIDTH_AXIS_NOTE } from './mapStack';
import { chokeSpans, finSlots, targetFins } from './candles';

export type Family = 'P' | 'X' | 'R' | 'S' | 'C' | 'T' | 'K';

export interface PlateDef {
  key: string;
  family: Family;
  index: number;
  count: number;
  plane: Plane;
  u0: number;
  u1: number;
  /** Where the plate was designed, when a move has carried it elsewhere (plane is then the moved one). */
  home?: Plane;
}

export interface Part {
  id: string;
  plateKey: string;
  family: Family;
  index: number;
  piece: number;
  plane: Plane;
  thickness: number;
  shape: Shape; // exactly one ExPoly: one physical piece
  etch: Path[];
  labelPaths: Path[];
  labelAt: Vec2 | null;
  /** Map credits / edition ETCH, generated after slice for export and fit-check. */
  exportEtch?: Path[];
  /** OSM ENGRAVE paths, generated after slice for export and fit-check. */
  exportEngrave?: Path[];
  area: number;
  perimeter: number;
  bbox: BBox;
  anchored: boolean;
  /** Stem id of the plate this piece belongs to (S-03). Equals `id` when the plate is one piece. */
  plateId?: string;
  /** Parts that aren't plates (spacers, braces…): the point a hand move turns about. */
  pivot?: V3;
  /** Where a loose part was designed, when a hand move has carried it elsewhere (plane is the moved one). */
  home?: Plane;
  kind: 'plate';
}

export interface PlateInfo {
  def: PlateDef;
  parts: Part[];
  /** Mean width of the bevel a 3D boolean would have left (front vs back section). */
  bevel: number;
  /** Area of insert material that would hit the plate (mm²). */
  collision: number;
  collisionAt: Vec2 | null;
  islands: number;
  cavity: Shape;
  sweptInsert: Shape;
  /** Tenons dropped into the embedded support ring. */
  tenons: number;
}

export interface FrontWindow {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * Lowest and highest outline vertices above the concrete (y > 0.5 mm).
 * This is the terrain span actually cut into the plates — not each plate’s
 * bounding-box top, which ignores valleys on the same slice.
 */
export function plateOutlineYRangeMm(plates: PlateInfo[]): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const pl of plates) {
    if (pl.def.family !== 'P' && pl.def.family !== 'R') continue;
    for (const part of pl.parts) {
      for (const ex of part.shape) {
        for (const p of ex.outer) {
          if (p[1] > 0.5) {
            lo = Math.min(lo, p[1]);
            hi = Math.max(hi, p[1]);
          }
        }
      }
    }
  }
  return Number.isFinite(hi) && Number.isFinite(lo) ? { lo, hi } : null;
}

/** Span of plate top edges above the concrete line (mm). */
export function plateTopHeightRangeMm(plates: PlateInfo[]): number {
  const r = plateOutlineYRangeMm(plates);
  return r ? r.hi - r.lo : 0;
}

/** How many P/R plates share the highest cut outline (exact summit plateau). */
export function countPlatesAtMaxHeight(plates: PlateInfo[], epsMm = 0.05): number {
  const all = plateOutlineYRangeMm(plates);
  if (!all) return 0;
  let n = 0;
  for (const pl of plates) {
    const r = plateOutlineYRangeMm([pl]);
    if (r && Math.abs(r.hi - all.hi) <= epsMm) n++;
  }
  return n;
}

export interface SliceResult {
  plates: PlateInfo[];
  parts: Part[];
  /** Sub-minimum or unsupported pieces that were merged, dropped, or kept. */
  fragments: FragmentEvent[];
  warnings: string[];
  front: FrontWindow | null;
  top: TopWindow | null;
  support: SupportSpec | null;
  /** Target note per plate (aligned with `plates`), when Tuning is on. */
  tuning: (PlateTune | null)[] | null;
  brace: BraceResult | null;
  /** Vertical support poles through a flat stack; null unless Support poles is on. */
  stackRods: StackRodPlan | null;
  /** The plates where Round all corners moved an edge the furthest, most first (empty when it is off). */
  roundSpots?: RoundSpot[];
}

export interface BraceResult {
  rods: RodPlan | null;
  spacers: SpacerResult | null;
  hardware: HardwareRow[];
  issues: BraceIssue[];
}

export interface SliceInput {
  v: Values;
  hf: HeightField | null;
  source: IndexedMesh | null;
  insert: IndexedMesh | null;
  front: Gray | null;
  top?: Gray | null;
  /** Per-plate placement overrides, keyed by plate key (P3, X1, R5…). */
  moves?: PartMoves;
  /** Silhouette of the top image (1 = shape), when the plates should follow its outline. */
  topMask?: Gray | null;
  /** Metal each plate is cut from, by plate key (tuned plates ring by it). */
  materialFor?: (key: string) => string;
  /** Placed objects (postcards, boxes…) cut out of every plate they pass through, each with its own clearance. */
  objects?: { mesh: IndexedMesh; clearance: number; seat?: number; shoulder?: number; noCut?: boolean }[];
  /** Unobstructed view: plate material in these sight lines (card face to eye) is cut away. */
  sight?: { eye: V3; cards: SightCard[] } | null;
  /** Map terrain: skip image impression / strata-flow flatten; heights come from the map field. */
  mapTerrain?: boolean;
  /** Plan circles (x, z, r) the plates are choked in to: each plate keeps only what lies inside them. */
  choke?: [number, number, number][];
  /** The project asked for sliceAxis 'width' on a map face, which was evaluated as 'length'. */
  mapAxisForced?: boolean;
  /** Candlesticks held by target fins: where each stands and how its fins grip it. */
  candles?: { x: number; z: number; r: number; bottom: number; ry: number; slack: number; holder: { fins: number; reach: number; grip: number; spin: number; slotted?: boolean; engage?: number } }[];
}

const UP: V3 = [0, 1, 0];
const crossUp = (n: V3): V3 => [n[2], 0, -n[0]]; // up × n

function makePlane(origin: V3, normal: V3): Plane {
  return { origin, normal, u: crossUp(normal), v: UP };
}

export const baseTop = (v: Values) => (v.baseOn ? v.baseHeight : 0);
// flat layers sit on the base (held by registration pins) rather than sinking into it
export const embedOf = (v: Values) => (v.baseOn && v.sliceMode !== 'flat' ? v.embedDepth : 0);

/** The point a plate turns about when moved: mid-span, at the base top. */
export const platePivot = (d: PlateDef): V3 => planeToWorld(d.home ?? d.plane, (d.u0 + d.u1) / 2, 0);

/** Apply placement overrides: the moved plane becomes `plane`, the designed one is kept as `home`. */
export function placeDefs(defs: PlateDef[], moves: PartMoves | undefined): PlateDef[] {
  if (!moves) return defs;
  return defs.map((d) => {
    const plane = movePlane(d.plane, moves[d.key], platePivot(d));
    return plane === d.plane ? d : { ...d, plane, home: d.plane };
  });
}

/**
 * A rod plan re-expressed in a moved plate's own coordinates: where each rod passes
 * through it. Rods stay in order; one that misses the plate gets a NaN position, so it
 * cuts no hole and counts as a miss.
 */
function rodsThrough(plan: RodPlan, p: Plane): RodPlan {
  const rods = plan.rods.map((r) => {
    const d: V3 = [r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]];
    const dn = d[0] * p.normal[0] + d[1] * p.normal[1] + d[2] * p.normal[2];
    const k = Math.abs(dn) < 1e-6 ? NaN : ((p.origin[0] - r.a[0]) * p.normal[0] + (p.origin[1] - r.a[1]) * p.normal[1] + (p.origin[2] - r.a[2]) * p.normal[2]) / dn;
    if (!(k >= 0 && k <= 1)) return { ...r, u: NaN, y: NaN };
    const w: V3 = [r.a[0] + d[0] * k - p.origin[0], r.a[1] + d[1] * k - p.origin[1], r.a[2] + d[2] * k - p.origin[2]];
    return { ...r, u: w[0] * p.u[0] + w[1] * p.u[1] + w[2] * p.u[2], y: w[0] * p.v[0] + w[1] * p.v[1] + w[2] * p.v[2] };
  });
  return { ...plan, rods };
}

/**
 * Hand moves for parts that aren't plates (spacers, bracing pieces…): each is carried
 * rigidly about the middle of its base edge. The support ring stays put: it follows the plates.
 */
export function placeLooseParts(parts: Part[], moves: PartMoves | undefined, plateKeys: Set<string>): void {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.family === 'S' || plateKeys.has(p.plateKey)) continue;
    const pivot = planeToWorld(p.plane, (p.bbox.minX + p.bbox.maxX) / 2, p.bbox.minY);
    const plane = movePlane(p.plane, moves?.[p.plateKey], pivot);
    parts[i] = plane === p.plane ? { ...p, pivot } : { ...p, pivot, plane, home: p.plane };
  }
}

/** Where two plates' mid-planes cross at a given world height, as u on each; null if parallel or off the line. */
export function crossingAt(a: Plane, b: Plane, y: number): { ua: number; ub: number } | null {
  const na = a.normal, nb = b.normal;
  const d: V3 = [na[1] * nb[2] - na[2] * nb[1], na[2] * nb[0] - na[0] * nb[2], na[0] * nb[1] - na[1] * nb[0]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (dd < 1e-6 || Math.abs(d[1]) < 1e-3) return null;
  const ha = na[0] * a.origin[0] + na[1] * a.origin[1] + na[2] * a.origin[2];
  const hb = nb[0] * b.origin[0] + nb[1] * b.origin[1] + nb[2] * b.origin[2];
  // a point on the line: (ha (nb×d) + hb (d×na)) / |d|²
  const c1: V3 = [nb[1] * d[2] - nb[2] * d[1], nb[2] * d[0] - nb[0] * d[2], nb[0] * d[1] - nb[1] * d[0]];
  const c2: V3 = [d[1] * na[2] - d[2] * na[1], d[2] * na[0] - d[0] * na[2], d[0] * na[1] - d[1] * na[0]];
  const p0: V3 = [(ha * c1[0] + hb * c2[0]) / dd, (ha * c1[1] + hb * c2[1]) / dd, (ha * c1[2] + hb * c2[2]) / dd];
  const k = (y - p0[1]) / d[1];
  const W: V3 = [p0[0] + d[0] * k, y, p0[2] + d[2] * k];
  const uOf = (p: Plane) => (W[0] - p.origin[0]) * p.u[0] + (W[1] - p.origin[1]) * p.u[1] + (W[2] - p.origin[2]) * p.u[2];
  return { ua: uOf(a), ub: uOf(b) };
}

export function plateDefs(v: Values): PlateDef[] {
  const top = baseTop(v);
  const defs: PlateDef[] = [];
  if (v.sliceMode === 'radial') {
    const n = v.radialCount;
    const ch = v.baseOn ? baseChamfers(v) : { corner: 0, edge: 0 };
    const m = Math.max(v.sideMargin, ch.edge);
    const hx = Math.max(1, v.baseLength / 2 - m);
    const hz = Math.max(1, v.baseWidth / 2 - m);
    // stay the same margin inside a chamfered corner
    const diag = ch.corner > 0 ? v.baseLength / 2 + v.baseWidth / 2 - ch.corner - m * Math.SQRT2 : Infinity;
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const R = Math.min(Math.abs(c) > 1e-9 ? hx / Math.abs(c) : Infinity, Math.abs(s) > 1e-9 ? hz / Math.abs(s) : Infinity, diag / (Math.abs(c) + Math.abs(s)));
      const normal: V3 = [-s, 0, c];
      const plane: Plane = { origin: [0, top, 0], normal, u: [c, 0, s], v: UP };
      defs.push({ key: `R${k}`, family: 'R', index: k, count: n, plane, u0: Math.min(v.radialHub, R - 5), u1: R });
    }
    return defs;
  }
  if (v.sliceMode === 'flat') {
    const fp = flatFootprint(v);
    const n = Math.max(1, Math.round(v.plateCount));
    for (let i = 0; i < n; i++) {
      // horizontal plane: plan coords (x, -z), extruded upwards, centred on the layer.
      // Layers are plates of the main stack (family P), just laid flat.
      const plane: Plane = { origin: [0, top + (i + 0.5) * v.thickness, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] };
      defs.push({ key: `L${i}`, family: 'P', index: i, count: n, plane, u0: fp.minX, u1: fp.maxX });
    }
    return defs;
  }
  const f = stackFrame(v);
  const n = v.plateCount;
  const w = v.plateWidth;
  for (let i = 0; i < n; i++) {
    const s = (i - (n - 1) / 2) * v.pitch;
    defs.push({
      key: `P${i}`,
      family: 'P',
      index: i,
      count: n,
      plane: makePlane([s * f.stack[0], top, s * f.stack[1]], [f.stack[0], 0, f.stack[1]]),
      u0: -w / 2,
      u1: w / 2,
    });
  }
  if (v.sliceMode === 'waffle') {
    const m = v.crossCount;
    const cp = w / m;
    const ext = Math.min(((n - 1) / 2) * v.pitch + v.pitch / 2, f.stackLen / 2 - Math.min(v.sideMargin, f.stackLen / 4));
    for (let j = 0; j < m; j++) {
      const a = -w / 2 + cp * (j + 0.5);
      defs.push({
        key: `X${j}`,
        family: 'X',
        index: j,
        count: m,
        plane: makePlane([a * f.across[0], top, a * f.across[1]], [f.across[0], 0, f.across[1]]),
        u0: -ext,
        u1: ext,
      });
    }
  }
  return defs;
}

/**
 * A map plate's top line: sampled every `curveStep` mm, smoothed with a Gaussian
 * of `curveSmooth` mm and simplified at `curveTolerance` mm, so the arc fitter
 * can write most of it as arcs instead of hundreds of short kinked lines.
 */
function mapOutline(def: PlateDef, hf: HeightField, v: Values): Shape {
  const { u0, u1, plane } = def;
  const n = Math.max(2, Math.ceil((u1 - u0) / Math.max(0.05, v.curveStep)));
  const du = (u1 - u0) / n;
  const raw = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const p = planeToWorld(plane, u0 + du * k, 0);
    raw[k] = hf.at(p[0], p[2]);
  }
  const h = gaussian1d(raw, v.curveSmooth / du);
  const top: Path = [];
  for (let k = 0; k <= n; k++) top.push([u0 + du * k, h[k]]);
  // simplify before the union so Clipper sees hundreds of points, not thousands
  const tol = Math.max(0.001, v.curveTolerance);
  return outlineUnder(def, simplifyOpen(top, tol), v, tol);
}

/** Douglas-Peucker on an open line; both ends are kept. */
function simplifyOpen(p: Path, tol: number): Path {
  const n = p.length;
  if (n < 3) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = p[a], B = p[b];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L = Math.hypot(dx, dy) || 1e-12;
    let idx = -1, dmax = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((p[i][0] - A[0]) * dy - (p[i][1] - A[1]) * dx) / L;
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/** Gaussian low-pass of a profile, `sigma` in samples, ends clamped. */
export function gaussian1d(src: Float64Array, sigma: number): Float64Array {
  if (!(sigma >= 0.3)) return src;
  const r = Math.ceil(3 * sigma);
  const wts = new Float64Array(r + 1);
  let total = 0;
  for (let j = 0; j <= r; j++) {
    wts[j] = Math.exp(-(j * j) / (2 * sigma * sigma));
    total += j ? 2 * wts[j] : wts[j];
  }
  const last = src.length - 1;
  const out = new Float64Array(src.length);
  for (let k = 0; k <= last; k++) {
    let sum = wts[0] * src[k];
    for (let j = 1; j <= r; j++) sum += wts[j] * (src[Math.max(0, k - j)] + src[Math.min(last, k + j)]);
    out[k] = sum / total;
  }
  return out;
}

function strataOutline(def: PlateDef, hf: HeightField, v: Values): Shape {
  const { u0, u1, plane } = def;
  const step = Math.max(0.5, v.sampleStep);
  const n = Math.max(2, Math.ceil((u1 - u0) / step));
  const top: Path = [];
  for (let k = 0; k <= n; k++) {
    const u = u0 + ((u1 - u0) * k) / n;
    const p = planeToWorld(plane, u, 0);
    top.push([u, hf.at(p[0], p[2])]);
  }
  // strata flow: low-pass the top line (two box passes ≈ a gentle gaussian) into long curves
  const win = Math.round(v.edgeFlow / 2 / ((u1 - u0) / n));
  if (win >= 1) {
    for (let pass = 0; pass < 2; pass++) {
      const h = top.map((q) => q[1]);
      for (let k = 0; k < top.length; k++) {
        let sum = 0, cnt = 0;
        for (let j = Math.max(0, k - win); j <= Math.min(top.length - 1, k + win); j++) {
          sum += h[j];
          cnt++;
        }
        top[k][1] = sum / cnt;
      }
    }
  }
  return outlineUnder(def, top, v);
}

/** A plate whose top is flat at `height` above the concrete: a tuned tine. */
function tunedOutline(def: PlateDef, height: number, v: Values): Shape {
  return outlineUnder(def, [[def.u0, height], [def.u1, height]], v);
}

/** The plate outline: the given top line (left to right), the sides, and the embedded tab. */
function outlineUnder(def: PlateDef, top: Path, v: Values, tol = 0.01): Shape {
  const { u0, u1 } = def;
  const e = embedOf(v);
  const inset = Math.max(0, Math.min(v.tabInset, (u1 - u0) / 2 - 5));
  const poly: Path = [];
  if (e > 0 && inset > 0) poly.push([u0 + inset, -e], [u1 - inset, -e], [u1 - inset, 0], [u1, 0]);
  else if (e > 0) poly.push([u0, -e], [u1, -e]);
  else poly.push([u0, 0], [u1, 0]);
  for (let k = top.length - 1; k >= 0; k--) poly.push(top[k]);
  if (e > 0 && inset > 0) poly.push([u0, 0], [u0 + inset, 0]);
  return simplifyShape(union([poly]), tol);
}

function formOutline(def: PlateDef, mesh: IndexedMesh, v: Values): Shape {
  let sec = sectionShape(mesh, def.plane);
  if (def.family === 'R') sec = intersection(sec, rect(def.u0, -BIG, BIG, BIG));
  if (!sec.length) return [];
  const e = embedOf(v);
  if (e <= 0) return sec;
  const band = intersection(sec, rect(-BIG, 0, BIG, 0.3));
  if (!band.length) return sec;
  const bb = shapeBBox(band);
  const inset = Math.max(0, Math.min(v.tabInset, (bb.maxX - bb.minX) / 2 - 3));
  return unionShapes(sec, rect(bb.minX + inset, -e, bb.maxX - inset, 0.15));
}

/** The u-extent of each separate embedded tab (one per piece when a plate is trimmed into several). */
function tabRanges(outline: Shape, e: number): [number, number][] {
  const band = intersection(outline, rect(-BIG, -e + 0.5, BIG, -0.5));
  return band.map((ex) => {
    const bb = bboxOf([ex.outer]);
    return [bb.minX, bb.maxX];
  });
}

interface FrontCtx {
  img: Gray;
  win: FrontWindow; // fitted image rectangle in plate coords
}

function frontContext(v: Values, img: Gray | null, defs: PlateDef[], hf: HeightField | null, lowestTop: number | null = null): FrontCtx | null {
  if (!img || v.sliceMode !== 'parallel') return null;
  if (v.imgFrontMode === 'off' && v.etchMode === 'off') return null;
  const p = defs.find((d) => d.family === 'P');
  if (!p) return null;
  const m = v.frontMargin;
  const u0 = p.u0 + m, u1 = p.u1 - m;
  const topV = lowestTop ?? (hf ? hf.min : v.stackHeight);
  const v0 = m, v1 = topV - m;
  if (u1 - u0 < 5 || v1 - v0 < 5) return null;
  const ar = img.w / img.h;
  const w = u1 - u0, h = v1 - v0;
  let win: FrontWindow;
  if (w / h > ar) {
    const fw = h * ar;
    win = { u0: (u0 + u1) / 2 - fw / 2, u1: (u0 + u1) / 2 + fw / 2, v0, v1 };
  } else {
    const fh = w / ar;
    win = { u0, u1, v0: (v0 + v1) / 2 - fh / 2, v1: (v0 + v1) / 2 + fh / 2 };
  }
  return { img, win };
}

/** Darkness 0..1 of the front image at plate coords. Looking at the stack from the front, image-right is -u. */
function darkAt(ctx: FrontCtx, u: number, vv: number): number {
  const { win } = ctx;
  if (u < win.u0 || u > win.u1 || vv < win.v0 || vv > win.v1) return 0;
  return 1 - sample(ctx.img, (win.u1 - u) / (win.u1 - win.u0), (win.v1 - vv) / (win.v1 - win.v0));
}

function fieldLoops(ctx: FrontCtx, level: number, strength: number): { loops: Path[]; cell: number } {
  const { win } = ctx;
  const w = win.u1 - win.u0, h = win.v1 - win.v0;
  const cell = Math.min(5, Math.max(1.2, w / 110));
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  const field = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) field[r * cols + c] = darkAt(ctx, win.u0 + c * cell, win.v0 + r * cell) * strength - level;
  const loops = marchingSquares(field, cols, rows).map((l) => l.map(([x, y]) => [win.u0 + x * cell, win.v0 + y * cell] as Vec2));
  return { loops, cell };
}

function frontCut(def: PlateDef, outline: Shape, v: Values, ctx: FrontCtx): Shape {
  if (def.family !== 'P' || def.index >= v.frontDepth) return [];
  const cut = imageCut(def, v, ctx);
  if (!cut.length) return [];
  return intersection(cut, offset(outline, -v.frontMargin));
}

/**
 * The image-driven cut-out for one plate before it is framed by the plate's
 * outline. It depends only on the image, its window and a few image settings,
 * so it is cached on the image and survives edits to the strata, edges, etc.
 */
function imageCut(def: PlateDef, v: Values, ctx: FrontCtx): Shape {
  const { win } = ctx;
  const level = v.imgFrontMode === 'layers' ? (def.index + 0.5) / v.frontDepth : 0;
  const key = [win.u0, win.u1, win.v0, win.v1, v.imgFrontMode, level, v.imgFrontStrength, v.minFeature, v.halftoneSpacing].join(',');
  return cached(ctx.img, key, () => imageCutUncached(level, v, ctx));
}

function imageCutUncached(level: number, v: Values, ctx: FrontCtx): Shape {
  const strength = v.imgFrontStrength;
  let cut: Shape = [];
  if (v.imgFrontMode === 'layers') {
    const { loops } = fieldLoops(ctx, level, strength);
    if (!loops.length) return [];
    cut = union(loops, 'evenodd');
    const r = Math.max(0.3, v.minFeature / 2);
    cut = offset(offset(cut, -r), r); // drop slivers the laser can't hold
  } else if (v.imgFrontMode === 'halftone') {
    const sp = v.halftoneSpacing;
    const { win } = ctx;
    const circles: Path[] = [];
    const minD = Math.max(v.minFeature, 1.5);
    const dy = sp * 0.866;
    for (let row = 0, vv = win.v0 + sp / 2; vv <= win.v1 - sp / 2 + 1e-6; row++, vv += dy) {
      for (let u = win.u0 + sp / 2 + (row % 2 ? sp / 2 : 0); u <= win.u1 - sp / 2 + 1e-6; u += sp) {
        const d = darkAt(ctx, u, vv);
        const r = 0.5 * (sp - v.minFeature) * Math.sqrt(Math.min(1, d * strength * 1.6));
        if (2 * r >= minD) circles.push(circlePath(u, vv, r));
      }
    }
    if (!circles.length) return [];
    cut = union(circles);
  }
  return cut;
}

function frontEtch(def: PlateDef, v: Values, ctx: FrontCtx): Path[] {
  if (def.family !== 'P' || v.etchMode === 'off') return [];
  const strength = v.imgFrontMode === 'off' ? 1 : Math.max(0.05, v.imgFrontStrength);
  const { win } = ctx;
  if (v.etchMode === 'hatch') {
    // identical lines on every plate, so they line up across the stack
    const lines: Path[] = [];
    const step = Math.max(0.5, (win.u1 - win.u0) / 200);
    const thr = Math.max(0.02, 1 - strength);
    for (let vv = win.v0 + v.etchSpacing / 2; vv < win.v1; vv += v.etchSpacing) {
      let start: number | null = null;
      for (let u = win.u0; u <= win.u1 + step / 2; u += step) {
        const on = u <= win.u1 && darkAt(ctx, u, vv) > thr;
        if (on && start === null) start = u;
        if (!on && start !== null) {
          if (u - start > 1) lines.push([[start, vv], [u - step, vv]]);
          start = null;
        }
      }
    }
    return lines;
  }
  // contour: one iso-line per plate, so the stack spreads the tonal range
  const level = (def.index + 0.5) / def.count;
  const { loops } = fieldLoops(ctx, level, strength);
  return loops.filter((l) => l.length > 4).map((l) => [...l, l[0]]);
}

// ---------------------------------------------------------------------------
// Top-surface impression: looking down on the stack, every plate's top edge is
// cut down where its strip of the image is dark, so the image reads across the
// whole top surface. Steps give crisp vertical risers, like layered cut-outs.

export interface TopWindow {
  /** Screen axes of the plan view seen from the front end: right and away-from-viewer (stack), in world XZ. */
  right: [number, number];
  stack: [number, number];
  r0: number;
  r1: number;
  s0: number;
  s1: number;
  /** quarter turns of the image on the surface (clockwise, seen from above with the front at the bottom) */
  turns: number;
}

/**
 * Image rectangle on the footprint. Viewed from above with the front plate at
 * the bottom (the stack running away from you), the image sits upright:
 * image right = right when standing at the front, image top = the far end.
 */
export function topWindow(v: Values, img: Gray, defs: PlateDef[]): TopWindow | null {
  if (!defs.length) return null;
  // flat layers: the window spans the footprint; upright plates: the ends of every plate
  const pts: V3[] =
    v.sliceMode === 'flat'
      ? (() => {
          const fp = flatFootprint(v);
          return [[fp.minX, 0, -fp.minY], [fp.maxX, 0, -fp.maxY]] as V3[];
        })()
      : defs.flatMap((d) => [d.u0, d.u1].map((u) => planeToWorld(d.plane, u, 0)));
  const f = stackFrame(v);
  const stack: [number, number] = [f.stack[0], f.stack[1]];
  const right: [number, number] = [-f.stack[1], f.stack[0]];
  let r0 = Infinity, r1 = -Infinity, s0 = Infinity, s1 = -Infinity;
  for (const p of pts) {
    const r = p[0] * right[0] + p[2] * right[1];
    const sv = p[0] * stack[0] + p[2] * stack[1];
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
    s0 = Math.min(s0, sv);
    s1 = Math.max(s1, sv);
  }
  const m = v.topMargin;
  r0 += m;
  r1 -= m;
  s0 += m;
  s1 -= m;
  if (r1 - r0 < 2 || s1 - s0 < 2) return null;
  const turns = ((Math.round(Number(v.topRotate) / 90) % 4) + 4) % 4;
  const ar = turns % 2 ? img.h / img.w : img.w / img.h; // on-surface width runs along `right`, height along `stack`
  let w = r1 - r0, h = s1 - s0;
  if (w / h > ar) w = h * ar;
  else h = w / ar;
  w *= v.topScale;
  h *= v.topScale;
  const cr = (r0 + r1) / 2 + v.topX * right[0] + v.topZ * right[1];
  const cs = (s0 + s1) / 2 + v.topX * stack[0] + v.topZ * stack[1];
  return { right, stack, r0: cr - w / 2, r1: cr + w / 2, s0: cs - h / 2, s1: cs + h / 2, turns };
}

/** Image coordinates (0..1, y down) of a world point, or null outside the image. */
export function topUV(win: TopWindow, p: V3): [number, number] | null {
  const r = p[0] * win.right[0] + p[2] * win.right[1];
  const sv = p[0] * win.stack[0] + p[2] * win.stack[1];
  if (r < win.r0 || r > win.r1 || sv < win.s0 || sv > win.s1) return null;
  const a = (r - win.r0) / (win.r1 - win.r0); // across the window, left → right
  const b = (win.s1 - sv) / (win.s1 - win.s0); // far end → front
  switch (win.turns) {
    case 1:
      return [b, 1 - a];
    case 2:
      return [1 - a, 1 - b];
    case 3:
      return [1 - b, a];
    default:
      return [a, b];
  }
}

/**
 * Depth field (0..1) for a top-surface profile. For "tone" it is the image's
 * darkness above the threshold; for pillow / balloon / chamfer it comes from
 * each point's distance to the edge of the dark shape, so a flat silhouette
 * inflates from its outline.
 */
export function topProfileField(v: Values, img: Gray, win: TopWindow): Gray {
  const thr = Math.min(0.99, v.topThreshold);
  const n = img.w * img.h;
  const data = new Float32Array(n);
  if (v.topProfile === 'tone' || !v.topProfile) {
    for (let i = 0; i < n; i++) data[i] = Math.max(0, Math.min(1, (1 - img.data[i] - thr) / (1 - thr)));
    return { w: img.w, h: img.h, data };
  }
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = 1 - img.data[i] > thr ? 1 : 0;
  const dist = distanceInside(inside, img.w, img.h);
  // image columns run along `right` unless the image is turned a quarter
  const mmPerPx = (win.turns % 2 ? win.s1 - win.s0 : win.r1 - win.r0) / img.w;
  let R = Math.max(0.5, v.topBillow) / mmPerPx;
  if (v.topProfile === 'balloon') {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, dist[i]);
    R = Math.max(1, max);
  }
  const puff = Math.min(5, Math.max(0.2, Number.isFinite(v.topPuff) ? v.topPuff : 1));
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    const t = Math.min(1, dist[i] / R);
    const f = v.topProfile === 'chamfer' ? t : Math.sqrt(1 - (1 - t) * (1 - t)); // quarter-circle shoulder
    data[i] = puff === 1 ? f : Math.pow(f, puff);
  }
  return { w: img.w, h: img.h, data };
}

/** Highest point of the outline above u (the top edge), or null if the vertical misses it. */
export function topAt(shape: Shape, u: number): number | null {
  let best = -Infinity;
  for (const ex of shape) {
    const p = ex.outer;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[j], b = p[i];
      if (a[0] <= u !== b[0] <= u) {
        const y = a[1] + ((u - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
        if (y > best) best = y;
      }
    }
  }
  return best === -Infinity ? null : best;
}

/**
 * Round a carved floor (heights g on a grid of spacing d) like a ball of radius r rolled
 * over it: first from below (shoulders and step edges), then from above (pit bottoms and
 * the foot of each wall). The ball shrinks to fit any tower or slot narrower than 2r, so
 * a busy picture keeps every feature, just rounded, instead of narrow ones being flattened
 * into lumps or filled over. Each end is either a wall (an uncut stretch of plate, kept
 * crisp at its rim) or open (the plate's own end: the floor simply carries on).
 */
export function roundFloor(g: number[], d: number, r: number, wallA: boolean, wallB: boolean): number[] {
  const k = Math.ceil(r / d) + 2;
  const pad = (wall: boolean, edge: number) => new Array<number>(k).fill(wall ? Infinity : edge);
  const f = [...pad(wallA, g[0]), ...g, ...pad(wallB, g[g.length - 1])];
  const closed = rollBall(rollBall(f, d, r).map((x) => -x), d, r).map((x) => -x);
  return closed.slice(k, k + g.length);
}

/**
 * Grey-scale opening of f by a half-disc whose radius at each centre is r, cut down to half
 * the width of the feature there (the stretch around it within r/2 of its height or higher).
 * Never raises f, never drops below the lowest value within reach.
 */
function rollBall(f: number[], d: number, r: number): number[] {
  const n = f.length;
  const out = f.map((x) => (Number.isFinite(x) ? -Infinity : x));
  const tol = r / 2;
  const reach = Math.ceil((2 * r) / d);
  const size = f.map((fc, c) => {
    if (fc === -Infinity) return 0;
    if (fc === Infinity) return r; // a wall (solid up to the sky) is as wide as it needs to be
    let a = c, b = c;
    while (a > 0 && c - a < reach && f[a - 1] >= fc - tol) a--;
    while (b < n - 1 && b - c < reach && f[b + 1] >= fc - tol) b++;
    return Math.min(r, ((b - a) * d) / 2);
  });
  for (let c = 0; c < n; c++) {
    if (f[c] === -Infinity) continue;
    // the ball shrinks for any narrow feature within its reach, so one feature is rounded by one size
    let rho = size[c];
    const k0 = Math.floor(rho / d);
    for (let j = Math.max(0, c - k0); j <= Math.min(n - 1, c + k0); j++) if (f[j] !== -Infinity && size[j] < rho) rho = size[j];
    const kc = Math.floor(rho / d + 1e-9);
    let y = Infinity;
    for (let j = Math.max(0, c - kc); j <= Math.min(n - 1, c + kc); j++) {
      const t = (j - c) * d;
      y = Math.min(y, f[j] - Math.sqrt(Math.max(0, rho * rho - t * t)));
    }
    if (!Number.isFinite(y)) continue;
    for (let j = Math.max(0, c - kc); j <= Math.min(n - 1, c + kc); j++) {
      if (!Number.isFinite(f[j])) continue;
      const t = (j - c) * d;
      const h = y + Math.sqrt(Math.max(0, rho * rho - t * t));
      if (h > out[j]) out[j] = h;
    }
  }
  // a point no ball could reach (squeezed against a wall) carries on its neighbour's curve
  const free = (j: number) => Number.isFinite(f[j]) && out[j] !== -Infinity;
  for (let j = 1; j < n; j++) if (out[j] === -Infinity && free(j - 1)) out[j] = Math.min(f[j], out[j - 1]);
  for (let j = n - 2; j >= 0; j--) if (out[j] === -Infinity && free(j + 1)) out[j] = Math.min(f[j], out[j + 1]);
  for (let j = 0; j < n; j++) if (out[j] === -Infinity) out[j] = f[j];
  return out;
}

function topCarve(def: PlateDef, outline: Shape, v: Values, img: Gray, win: TopWindow, datum: number): Shape {
  const step = Math.min(1, v.sampleStep);
  const n = Math.max(2, Math.ceil((def.u1 - def.u0) / step));
  const us: number[] = [];
  const tops: number[] = [];
  const lv: number[] = [];
  const on: boolean[] = []; // the sample lands on the plate
  const steps = Math.round(v.topSteps);
  for (let k = 0; k <= n; k++) {
    const u = def.u0 + ((def.u1 - def.u0) * k) / n;
    const t = topAt(outline, u);
    us.push(u);
    tops.push(t ?? 0);
    on.push(t !== null && t > 0);
    const p = planeToWorld(def.plane, u, 0);
    let f = 0;
    const uv = t !== null && t > 0 ? topUV(win, p) : null;
    if (uv) {
      const level = sample(img, uv[0], uv[1]); // img is the profile field (0..1 depth)
      f = v.imgTopMode === 'raise' ? 1 - level : level;
      if (steps > 0) f = Math.round(f * steps) / steps;
    }
    lv.push(f);
  }
  // drop runs narrower than the minimum feature (slivers of material or of cut). Stepped
  // profiles clean up every terrace; smooth ones only where the cut starts and stops.
  // rounding keeps every feature it is given, so with cut smoothing on the narrowest ones go first
  // (up to twice the minimum feature): rounded down to a needle they would be too thin to cut
  const minW = Math.max(v.minFeature, 0.5, Math.min(2 * v.minFeature, 2 * v.cutSmooth));
  const minRun = Math.max(1, Math.ceil(minW / step));
  // at a plate's own end the image fades into its background (anti-aliasing, blur), which would leave a
  // thin shoulder standing there: carry the level a little way in out to the end
  for (let k = 0; k < lv.length; k++) {
    if (!on[k] || (k > 0 && on[k - 1])) continue;
    let e = k;
    while (e + 1 < lv.length && on[e + 1]) e++;
    if (e - k + 1 <= 2 * minRun) continue;
    for (let q = 0; q < minRun; q++) {
      lv[k + q] = lv[k + minRun];
      lv[e - q] = lv[e - minRun];
    }
  }
  // samples off the plate are their own run, so a sliver at the plate's end is cleaned like any other
  const key = (k: number) => (!on[k] ? -1 : steps > 0 ? lv[k] : lv[k] > 0 ? 1 : 0);
  for (let pass = 0; pass < 2; pass++) {
    let a = 0;
    while (a < lv.length) {
      let b = a;
      while (b + 1 < lv.length && key(b + 1) === key(a)) b++;
      const before = a > 0 && on[a - 1], after = b < lv.length - 1 && on[b + 1];
      if (on[a] && b - a + 1 < minRun + (before && after ? 0 : 1) && (before || after)) {
        const fill = before ? lv[a - 1] : lv[b + 1];
        for (let k = a; k <= b; k++) lv[k] = steps > 0 || fill <= 0 ? fill : Math.max(lv[k], fill);
      }
      a = b + 1;
    }
  }
  // a smooth (unstepped) impression picks up every speck of grain in the picture; with cut
  // smoothing on, low-pass it along the plate first so the rounding draws one flowing curve.
  // Only inside each cut stretch, so where the cut starts and stops does not move.
  if (steps === 0 && v.cutSmooth > 0.05) {
    const h = Math.round(v.cutSmooth / 2 / step);
    for (let a = 0; a < lv.length && h >= 1; a++) {
      if (!(on[a] && lv[a] > 0)) continue;
      let b = a;
      while (b + 1 < lv.length && on[b + 1] && lv[b + 1] > 0) b++;
      for (let pass = 0; pass < 2; pass++) {
        const src = lv.slice(a, b + 1);
        for (let q = 0; q < src.length; q++) {
          let sum = 0, cnt = 0;
          for (let j = Math.max(0, q - h); j <= Math.min(src.length - 1, q + h); j++) {
            sum += src[j];
            cnt++;
          }
          lv[a + q] = sum / cnt;
        }
      }
      a = b;
    }
  }
  // flat: every step is a level terrace below the lowest top inside the image; follow: offset from the local top
  const depthAt = (k: number) => {
    if (lv[k] <= 0) return 0;
    const d = v.topFloor === 'follow' ? lv[k] * v.topDepth : tops[k] - (datum - lv[k] * v.topDepth);
    return Math.max(0, Math.min(d, tops[k] - 5));
  };
  const ceiling = Math.max(...tops) + 50;
  const r = v.cutSmooth;
  const polys: Path[] = [];
  let k = 0;
  while (k < lv.length) {
    if (depthAt(k) <= 0) {
      k++;
      continue;
    }
    const k0 = k;
    while (k + 1 < lv.length && depthAt(k + 1) > 0) k++;
    const k1 = k;
    // a run that reaches the plate's end (e.g. trimmed to a silhouette) carries on past it
    const ua = k0 > 0 && on[k0 - 1] ? (us[k0 - 1] + us[k0]) / 2 : us[k0] - step - 1;
    const ub = k1 < lv.length - 1 && on[k1 + 1] ? (us[k1] + us[k1 + 1]) / 2 : us[k1] + step + 1;
    if (r > 0.05) {
      // rounded: rebuild the floor on a fine grid and roll a ball over it (see roundFloor)
      const d = step / 2;
      const m = Math.max(2, Math.ceil((ub - ua) / d));
      const gu: number[] = [];
      const g: number[] = [];
      let q = k0;
      for (let j = 0; j <= m; j++) {
        const u = ua + ((ub - ua) * j) / m;
        while (q < k1 && u > (us[q] + us[q + 1]) / 2) q++;
        const lin = q < k1 && u > us[q] ? tops[q] + ((tops[q + 1] - tops[q]) * (u - us[q])) / (us[q + 1] - us[q]) : q > k0 && u < us[q] ? tops[q] + ((tops[q - 1] - tops[q]) * (us[q] - u)) / (us[q] - us[q - 1]) : tops[q];
        gu.push(u);
        g.push(v.topFloor === 'follow' ? Math.max(5, lin - depthAt(q)) : tops[q] - depthAt(q));
      }
      // an uncut neighbour is a wall; the plate's own end is open
      const out = roundFloor(g, d, r, k0 > 0 && on[k0 - 1], k1 < lv.length - 1 && on[k1 + 1]);
      const lower: Path = gu.map((u, j) => [u, Math.min(ceiling, out[j])]);
      polys.push([...lower, [ub, ceiling], [ua, ceiling]]);
      k++;
      continue;
    }
    const ta = topAt(outline, ua) ?? tops[k0];
    const tb = topAt(outline, ub) ?? tops[k1];
    const lower: Path = [[ua, ta - depthAt(k0)]];
    for (let q = k0; q <= k1; q++) {
      if (q > k0 && lv[q] !== lv[q - 1]) {
        // crisp riser between depth steps
        const um = (us[q - 1] + us[q]) / 2;
        const tm = topAt(outline, um) ?? tops[q];
        lower.push([um, tm - depthAt(q - 1)], [um, tm - depthAt(q)]);
      }
      lower.push([us[q], tops[q] - depthAt(q)]);
    }
    lower.push([ub, tb - depthAt(k1)]);
    polys.push([...lower, [ub, ceiling], [ua, ceiling]]);
    k++;
  }
  return polys.length ? simplifyShape(union(polys), 0.02) : [];
}

// ---------------------------------------------------------------------------
// Shape outline: with a cut-out PNG on top, every plate is trimmed to the
// silhouette seen from above, so the whole stack takes on the shape.

/**
 * The silhouette laid on the footprint, in world XZ, grown (choke < 0) or
 * shrunk (choke > 0) by `choke` mm. Cached on the mask, so only a change of
 * image, window or choke rebuilds it.
 */
export function silhouetteFootprint(mask: Gray, win: TopWindow, choke: number): Shape {
  const key = [win.r0, win.r1, win.s0, win.s1, win.turns, ...win.right, ...win.stack, choke].join(',');
  return cached(mask, key, () => {
    const soft = boxBlur(mask, 1); // a light blur turns the pixel stair-steps into smooth contours
    const field = new Float32Array(soft.data.length);
    for (let i = 0; i < field.length; i++) field[i] = soft.data[i] - 0.5;
    const toWorld = ([x, y]: Vec2): Vec2 => {
      const ix = x / (mask.w - 1), iy = y / (mask.h - 1);
      // inverse of topUV: image coords back to window fractions (a across, b far → front)
      const [a, b] = win.turns === 1 ? [1 - iy, ix] : win.turns === 2 ? [1 - ix, 1 - iy] : win.turns === 3 ? [iy, 1 - ix] : [ix, iy];
      const r = win.r0 + a * (win.r1 - win.r0);
      const sv = win.s1 - b * (win.s1 - win.s0);
      return [r * win.right[0] + sv * win.stack[0], r * win.right[1] + sv * win.stack[1]];
    };
    const loops = marchingSquares(field, mask.w, mask.h).map((l) => l.map(toWorld));
    if (!loops.length) return [];
    let shape = simplifyShape(union(loops, 'evenodd'), 0.05);
    if (Math.abs(choke) > 1e-6) shape = offset(shape, -choke, 'round', SMOOTH_TOL);
    return shape;
  });
}

/** Spans of u where a plate's mid-plane runs inside the footprint (world XZ). */
export function footprintSpans(plane: Plane, foot: Shape): [number, number][] {
  const o = plane.origin;
  const local = ([x, z]: Vec2): Vec2 => {
    const dx = x - o[0], dz = z - o[2];
    return [dx * plane.u[0] + dz * plane.u[2], dx * plane.normal[0] + dz * plane.normal[2]];
  };
  const us: number[] = [];
  for (const ex of foot)
    for (const path of [ex.outer, ...ex.holes]) {
      const q = path.map(local);
      for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
        const a = q[j], b = q[i];
        if (a[1] <= 0 !== b[1] <= 0) us.push(a[0] + ((0 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
  us.sort((x, y) => x - y);
  const spans: [number, number][] = [];
  for (let k = 0; k + 1 < us.length; k += 2) if (us[k + 1] - us[k] > 1e-6) spans.push([us[k], us[k + 1]]);
  return spans;
}

/** Close gaps too narrow to cut and drop slivers of plate too narrow to stand. */
export function cleanSpans(spans: [number, number][], minFeature: number, minPart = 0): [number, number][] {
  const gap = Math.max(0.5, minFeature);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] - last[1] < gap) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  const minW = Math.max(3, 2 * minFeature, minPart);
  return merged.filter(([a, b]) => b - a >= minW);
}

interface Cavity {
  cavity: Shape;
  swept: Shape;
  /** The swept insert outside the cavity: anything of the plate in here collides. */
  sweptOutside: Shape;
  bevel: number;
}

/**
 * The insert cavity through one plate, from sections across its thickness.
 * It only depends on the insert and the plate's plane, so it is cached on the
 * insert mesh and survives edits to everything else (strata, image, edges...).
 */
function insertCavity(insert: IndexedMesh, plane: Plane, t: number, cavityMode: unknown, clearance: number): Cavity | null {
  const key = [...plane.origin, ...plane.normal, ...plane.u, ...plane.v, t, cavityMode, clearance].join(',');
  return cached(insert, key, () => {
    const offs = [-t / 2, -t / 4, 0, t / 4, t / 2];
    const secs = offs.map((d) => sectionShape(insert, offsetPlane(plane, d)));
    if (!secs.some((s) => s.length)) return null;
    const [frontS, , mid, , back] = secs;
    const swept = unionShapes(...secs);
    let chosen: Shape;
    if (cavityMode === 'smaller') chosen = intersection(frontS, back);
    else if (cavityMode === 'mid') chosen = mid;
    else chosen = unionShapes(frontS, mid, back);
    const cavity = offset(chosen, clearance);
    const per = (shapePerimeter(frontS) + shapePerimeter(back)) / 2;
    const bevel = per > 0 ? shapeArea(xor(frontS, back)) / per : 0;
    return { cavity, swept, sweptOutside: difference(swept, cavity), bevel };
  });
}

interface Seat {
  u0: number;
  u1: number;
  /** Plate top over this card (plate coordinates). */
  top: number;
}

/** Where each plate holds a shelf card, and the lowest seat of all (null when no card asks for a seat). */
function seatTops(objects: SliceInput['objects'], defs: PlateDef[], t: number): { plates: Seat[][]; floor: number } | null {
  const seated = (objects ?? []).filter((o) => o.seat !== undefined);
  if (!seated.length) return null;
  let floor = Infinity;
  const plates = defs.map((def) => {
    const out: Seat[] = [];
    for (const o of seated) {
      const cav = insertCavity(o.mesh, def.plane, t, 'larger', o.clearance);
      if (!cav) continue;
      const bb = shapeBBox(cav.cavity);
      const sh = o.shoulder ?? 5;
      const top = bb.minY + o.seat!;
      out.push({ u0: bb.minX - sh, u1: bb.maxX + sh, top });
      floor = Math.min(floor, top);
    }
    return out;
  });
  return Number.isFinite(floor) ? { plates, floor } : null;
}

/**
 * What to cut off a plate so its top steps down to its cards' seats: shoulders
 * either side of each notch rise to that card's seat, and the rest of the plate
 * drops to the lowest seat it holds (or the lowest of all, when it holds none).
 */
function seatTrim(seats: Seat[], floor: number): Shape {
  const low = seats.length ? Math.min(...seats.map((s) => s.top)) : floor;
  const keep = unionShapes(rect(-BIG, -BIG, BIG, low), ...seats.map((s) => rect(s.u0, -BIG, s.u1, s.top)));
  return difference(rect(-BIG, -BIG, BIG, BIG), keep);
}

/** Chord tolerance for smoothing offsets: well inside the DXF arc tolerance, far fewer points. */
const SMOOTH_TOL = 0.03;

/**
 * A chain of round offsets, tidied between steps. Each offset leaves near-duplicate points
 * where its arcs meet, sometimes doubling back by a few microns; offset again, such a
 * fold turns into a needle-thin slit as deep as the radius. Simplifying in between drops them.
 */
function morph(shape: Shape, deltas: number[]): Shape {
  let s = simplifyShape(shape, SMOOTH_TOL / 2);
  for (const d of deltas) s = simplifyShape(offset(s, d, 'round', SMOOTH_TOL), SMOOTH_TOL / 2);
  return s;
}

/**
 * Round the image-driven cut region itself (closing + opening of radius r),
 * then cut it out. Only the cut's own edges change (step edges, recess floors,
 * pixel stair-steps); the plate's outer edges are never touched.
 */
function smoothImageCuts(plate: Shape, cut: Shape, r: number): Shape {
  if (!(r > 0.05)) return difference(plate, cut);
  const rounded = morph(unionShapes(cut), [r, -2 * r, r]);
  return simplifyShape(difference(plate, rounded), SMOOTH_TOL / 2);
}

/**
 * Round the corners of the material: inside corners (valleys) by a closing of radius rIn,
 * then outside corners (peaks) by an opening of radius rOut. Where two rounded bumps meet,
 * the opening leaves a needle-thin inside cusp; a final 0.3 mm closing blunts it so no gap
 * is narrower than the kerf.
 */
export function roundAll(shape: Shape, rOut: number, rIn = rOut): Shape {
  const o = rOut > 0.05 ? rOut : 0, i = rIn > 0.05 ? rIn : 0;
  if (!(o || i) || !shape.length) return shape;
  const c = Math.min(0.3, Math.max(o, i) / 2);
  return morph(shape, [i, -i - o, o, c, -c].filter((d) => Math.abs(d) > 1e-9));
}

/**
 * The cheap floor under Round all corners: an opening of radius rOut, then a closing of rIn that
 * rounds the valleys and blunts the cusps the opening leaves where two rounded bumps meet.
 */
export function minimumRadius(shape: Shape, rOut: number, rIn: number): Shape {
  if (!(rOut > 0.05) || !shape.length) return shape;
  return morph(shape, rIn > 0.05 ? [-rOut, rOut, rIn, -rIn] : [-rOut, rOut]);
}

/** Where rounding moved a plate's edge the furthest, for the warning and the zoomed preview. */
export interface RoundSpot {
  key: string;
  label: string;
  /** The plate before and after rounding, in plate coordinates. */
  before: Shape;
  after: Shape;
  at: Vec2;
  /** How far the edge moved there, mm. */
  move: number;
}

/** The furthest any edge point moved between `before` and `after`, and where (points `skip` rejects aside). */
export function roundingMove(before: Shape, after: Shape, skip: (p: Vec2) => boolean = () => false): { move: number; at: Vec2 } {
  let move = 0;
  let at: Vec2 = [0, 0];
  for (const [changed, other] of [[difference(before, after), after], [difference(after, before), before]] as const) {
    for (const ex of changed) {
      if (Math.abs(signedArea(ex.outer)) < 0.2) continue;
      const bb = bboxOf([ex.outer]);
      const pad = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
      // only the other shape's edges near this piece can be the nearest
      const edges: [Vec2, Vec2][] = [];
      for (const oex of other)
        for (const path of [oex.outer, ...oex.holes])
          for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
            const a = path[j], b = path[i];
            if (Math.max(a[0], b[0]) < bb.minX - pad || Math.min(a[0], b[0]) > bb.maxX + pad || Math.max(a[1], b[1]) < bb.minY - pad || Math.min(a[1], b[1]) > bb.maxY + pad) continue;
            edges.push([a, b]);
          }
      for (const p of ex.outer) {
        if (skip(p)) continue;
        let best = Infinity;
        for (const [a, b] of edges) {
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
          best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
        }
        if (Number.isFinite(best) && best > move) {
          move = best;
          at = [p[0], p[1]];
        }
      }
    }
  }
  return { move, at };
}

function distToBoundary(p: Vec2, ex: ExPoly): number {
  let best = Infinity;
  for (const path of [ex.outer, ...ex.holes]) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[j], b = path[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

export function placeLabel(
  text: string,
  piece: ExPoly,
  prefer: Vec2,
  hMax: number,
  opts?: { clearHoles?: boolean },
): { paths: Path[]; at: Vec2 } | null {
  const shape = [piece];
  const bb = bboxOf([piece.outer]);
  const disks = opts?.clearHoles ? fastenerDisks(shape) : [];
  const holeClear = LABEL_HOLE_CLEAR_MM;
  for (const h of [hMax, hMax * 0.7, hMax * 0.5]) {
    const w = textWidth(text, h);
    if (w > bb.maxX - bb.minX - 2) continue;
    // the label box must sit inside material with 1 mm to spare, and clear of every hole
    const fits = (cx: number, cy: number) => {
      const pts: Vec2[] = [
        [cx, cy],
        [cx - w / 2, cy - h / 2],
        [cx + w / 2, cy - h / 2],
        [cx + w / 2, cy + h / 2],
        [cx - w / 2, cy + h / 2],
        [cx, cy - h / 2],
        [cx, cy + h / 2],
      ];
      if (!pts.every((p) => pointInShape(p, shape))) return false;
      // nothing of the boundary may cross the box (holes inside it, notches)
      for (const path of [piece.outer, ...piece.holes])
        for (const q of path) if (q[0] > cx - w / 2 - 1 && q[0] < cx + w / 2 + 1 && q[1] > cy - h / 2 - 1 && q[1] < cy + h / 2 + 1) return false;
      if (!pts.every((p) => distToBoundary(p, piece) >= 1)) return false;
      if (disks.length) {
        const minX = cx - w / 2, maxX = cx + w / 2, minY = cy - h / 2, maxY = cy + h / 2;
        for (const d of disks) {
          const qx = Math.max(minX, Math.min(d.c[0], maxX));
          const qy = Math.max(minY, Math.min(d.c[1], maxY));
          if (Math.hypot(d.c[0] - qx, d.c[1] - qy) < d.r + holeClear) return false;
        }
        const paths = strokeTextCentered(text, cx, cy, h);
        if (disks.some((d) => pathsHitDisk(paths, d.c, d.r + holeClear))) return false;
      }
      return true;
    };
    if (fits(prefer[0], prefer[1])) return { paths: strokeTextCentered(text, prefer[0], prefer[1], h), at: prefer };
    const step = opts?.clearHoles
      ? Math.max(h * 0.6, (bb.maxX - bb.minX) / 32, (bb.maxY - bb.minY) / 32)
      : Math.max(h, (bb.maxX - bb.minX) / 24, (bb.maxY - bb.minY) / 24);
    const cands: Vec2[] = [];
    for (let y = bb.minY + h; y <= bb.maxY - h; y += step) for (let x = bb.minX + w / 2 + 1; x <= bb.maxX - w / 2 - 1; x += step) cands.push([x, y]);
    cands.sort((a, b) => Math.hypot(a[0] - prefer[0], a[1] - prefer[1]) - Math.hypot(b[0] - prefer[0], b[1] - prefer[1]));
    for (const c of cands) if (fits(c[0], c[1])) return { paths: strokeTextCentered(text, c[0], c[1], h), at: c };
  }
  return null;
}

function labelPlatePiece(
  id: string,
  ex: ExPoly,
  v: Values,
  e: number,
  tune: PlateTune | null,
  def: PlateDef | null,
  clearHoles = false,
): { paths: Path[]; at: Vec2 | null } {
  const bb = bboxOf([ex.outer]);
  const hLab = Math.min(v.labelHeight, e > 0 ? e * 0.5 : v.labelHeight);
  const prefer: Vec2 = [(bb.minX + bb.maxX) / 2, e > 0 && bb.minY < -e / 2 ? -e / 2 : bb.minY + hLab];
  const holeOpts = clearHoles ? { clearHoles: true } : undefined;
  const lab = placeLabel(id, ex, prefer, hLab, holeOpts);
  let paths = lab?.paths ?? [];
  if (tune?.label && def) {
    const cx = (def.u0 + def.u1) / 2;
    const mid = tune.nodes && tune.nodes.length >= 2 ? -e + ((tune.nodes[0] + tune.nodes[1]) / 2) * tune.cut : (bb.minY + bb.maxY) / 2;
    const h = Math.min(Math.max(v.labelHeight, 7), (bb.maxY - bb.minY) * 0.16);
    const syl = placeLabel(tune.label, ex, [cx, mid], h, holeOpts);
    if (syl) paths = [...paths, ...syl.paths];
  }
  return { paths, at: lab?.at ?? null };
}

export function partLabel(v: Values, family: Family, index: number, count: number): string {
  const prefix = String(v.partPrefix || 'S').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'S';
  const digits = Math.max(2, String(count).length);
  const num = String(index + 1).padStart(digits, '0');
  return family === 'P' ? `${prefix}-${num}` : `${prefix}${family}-${num}`;
}

export function slice(input: SliceInput): SliceResult {
  const hf = input.hf;
  const v = input.mapTerrain ? { ...input.v, edgeFlow: 0 } : input.v;
  const warnings: string[] = [];
  if (input.mapTerrain && input.mapAxisForced) warnings.push(MAP_WIDTH_AXIS_NOTE);
  if (input.mapTerrain && hf?.heightCapScale != null && hf.heightCapScale < 1 - 1e-9) {
    warnings.push(
      `Terrain is taller than the ${v.stackHeight} mm plate height, so the whole map was scaled to fit (×${hf.heightCapScale.toFixed(2)}). Summits are not clipped.`,
    );
  }
  const fragmentEvents: FragmentEvent[] = [];
  const round: { spots: RoundSpot[] } = { spots: [] };
  const roundSplits: string[] = [];
  // design-side work (outlines, image cuts) happens where each plate was designed;
  // fit-side work (cavities, slots, tenons) where it has been moved to
  const homeDefs = plateDefs(v);
  if (input.mapTerrain) {
    for (const d of homeDefs) {
      if (d.family !== 'P') continue;
      d.plane = orientMapPlatePlane(d.plane);
    }
  }
  const defs = placeDefs(homeDefs, input.moves);
  const t = v.thickness;
  const e = embedOf(v);
  const useForm = v.stackSource === 'form';
  if (useForm && !input.source) warnings.push('Source form is missing (import a mesh or pick a shape).');
  if (v.sliceMode !== 'radial') {
    const run = (v.plateCount - 1) * v.pitch + t;
    const { stackLen } = stackFrame(v);
    if (v.baseOn && run > stackLen + 1e-6) warnings.push(`Plates span ${run.toFixed(1)} mm but the base is only ${stackLen.toFixed(1)} mm long: the end plates overhang.`);
  }

  // tuned plates: every main plate gets a flat top at the height that rings its note
  const main = defs.filter((d) => d.family === 'P' || d.family === 'R');
  const tunes = !useForm && tuningActive(v) ? tunePlates(v, main.length, input.materialFor ? main.map((d) => input.materialFor!(d.key)) : undefined, main.map((d) => d.u1 - d.u0)) : null;
  if (!useForm && tuningActive(v) && !tunes) warnings.push('Tuning: no readable notes. Use names like C3, F#2 or Bb4.');
  const tuning = tunes ? defs.map((d) => (d.family === 'P' || d.family === 'R' ? tunes[main.indexOf(d)] : null)) : null;
  if (tunes) {
    if (v.tuneModel !== 'free' && (!v.baseOn || embedOf(v) <= 0)) warnings.push('Tuning assumes each plate is clamped in the concrete: turn the base on and give the plates an embed depth.');
    const off = tunes.filter((t) => t.clamped);
    if (off.length) warnings.push(`Tuning: ${off.length} plate${off.length > 1 ? 's are' : ' is'} outside the ${MIN_TUNED}–${MAX_TUNED} mm height range at this thickness. Change the notes or the plate thickness.`);
  }

  // 1. outlines
  const isFlat = v.sliceMode === 'flat';
  const topWin = !input.mapTerrain && input.top && v.imgTopMode !== 'off' ? topWindow(v, input.top, homeDefs) : null;
  const topField = topWin && input.top ? topProfileField(v, input.top, topWin) : null;

  // flat stack: one sampled surface (strata top, stamped by the image) serves every layer
  let flat: FlatGrid | null = null;
  if (isFlat && (useForm ? input.source : hf)) {
    let formTop = 0;
    if (useForm && input.source) {
      const pos = input.source.pos;
      for (let i = 1; i < pos.length; i += 3) formTop = Math.max(formTop, pos[i]);
      formTop -= baseTop(v);
    }
    const stamp = topWin && topField ? { uv: (p: V3) => topUV(topWin, p), field: topField } : null;
    flat = flatGrid(v, flatFootprint(v), useForm ? null : hf, formTop, stamp);
    const top = flat.H.reduce((m, h) => Math.max(m, h), 0);
    if (defs.length * t < top - t) warnings.push(`Flat stack: ${defs.length} layers × ${t} mm only reach ${(defs.length * t).toFixed(0)} mm of the ${top.toFixed(0)} mm block; raise Plate count to keep the top.`);
  }
  const outlines = homeDefs.map((d, di) => {
    if (useForm) return input.source ? formOutline(d, input.source, v) : [];
    const tune = tuning?.[di];
    // a free bar's cut length includes nothing below the concrete line; the
    // outline still grows an embed tab when one is asked for
    if (tune) return tunedOutline(d, tune.model === 'free' ? tune.cut - e : tune.cut, v);
    if (isFlat) return flat ? flatOutline(flat, flatFootprint(v), (d.index + 0.5) * t) : [];
    if (!hf) return [];
    return input.mapTerrain ? mapOutline(d, hf, v) : strataOutline(d, hf, v);
  });

  // 1a. trim every plate to the top image's silhouette
  if (topWin && input.topMask && v.topOutline !== 'off') {
    const foot = silhouetteFootprint(input.topMask, topWin, Number(v.topChoke) || 0);
    // flat layers lie in plan (u = x, v = -z), so they take the footprint itself
    const footLayer = isFlat ? union(foot.flatMap((ex) => [ex.outer, ...ex.holes]).map((p) => p.map(([x, z]) => [x, -z] as Vec2)), 'evenodd') : [];
    if (isFlat) outlines.forEach((o, di) => {
      if (o.length) outlines[di] = intersection(o, footLayer);
    });
    else homeDefs.forEach((d, di) => {
      if (!outlines[di].length) return;
      const spans = cleanSpans(footprintSpans(d.plane, foot), v.minFeature, v.minPartSize);
      outlines[di] = spans.length ? intersection(outlines[di], spans.flatMap(([a, b]) => rect(a, -BIG, b, BIG))) : [];
    });
  }

  // 1b. tenons down into the embedded support ring
  const support = supportSpec(v, baseTop(v));
  const tenons = defs.map((d, di) => {
    if (!support) return { plane: d.plane, spans: [] as [number, number][] };
    const r = addTenons(outlines[di], d.plane, support, v, e);
    outlines[di] = r.outline;
    return { plane: d.plane, spans: r.spans };
  });

  // 2. waffle slots (computed from the shared intersection line, so both halves agree)
  const slots: Shape[] = defs.map(() => []);
  if (v.sliceMode === 'waffle') {
    const sw = t + v.slotClearance;
    defs.forEach((p, pi) => {
      if (p.family !== 'P') return;
      defs.forEach((x, xi) => {
        if (x.family !== 'X') return;
        // where the two plates cross at base top
        const c = crossingAt(p.plane, x.plane, baseTop(v));
        if (!c) return;
        const uP = c.ua, uX = c.ub;
        if (uP < p.u0 || uP > p.u1 || uX < x.u0 || uX > x.u1) return;
        const colP = intersection(outlines[pi], rect(uP - sw / 2, -BIG, uP + sw / 2, BIG));
        const colX = intersection(outlines[xi], rect(uX - sw / 2, -BIG, uX + sw / 2, BIG));
        if (!colP.length || !colX.length) return;
        const top = Math.min(shapeBBox(colP).maxY, shapeBBox(colX).maxY);
        const half = top / 2;
        // a slot that lands within a minimum feature of a plate's end (silhouette-trimmed plates) runs out
        // through it rather than leaving a sliver standing beside it
        const reach = sw / 2 + Math.max(0.5, v.minFeature);
        const widen = (o: Shape, u: number, y: number): [number, number] => [
          pointInShape([u - reach, y], o) ? u - sw / 2 : u - reach - 1,
          pointInShape([u + reach, y], o) ? u + sw / 2 : u + reach + 1,
        ];
        const [pa, pb] = widen(outlines[pi], uP, (half + top) / 2);
        const [xa, xb] = widen(outlines[xi], uX, half / 2);
        slots[pi].push(...rect(pa, half, pb, BIG));
        slots[xi].push(...rect(xa, -BIG, xb, half));
      });
    });
  }

  // threaded rods through the embedded tabs
  const rods = planRods(v, homeDefs, baseTop(v), e);
  const braceIssues: BraceIssue[] = rods ? [...rods.issues] : [];
  if (v.rodsOn && !rods && v.sliceMode !== 'parallel' && v.sliceMode !== 'waffle') braceIssues.push({ severity: 'info', message: 'Threaded rods need an upright parallel or waffle stack.' });
  if (rods && v.embedMode === 'slot') braceIssues.push({ severity: 'warn', message: 'Threaded rods are cast in with the plates: set Concrete › Plate fixing to "Cast in".' });
  const rodMiss: number[] = rods ? rods.rods.map(() => 0) : [];
  let rodMissKey: string | undefined;

  const front = frontContext(v, input.front, homeDefs, hf, tunes ? Math.min(...tunes.map((t) => t.cut)) : null);
  // datum for flat impression floors: the lowest plate top inside the image window
  let topDatum = Infinity;
  if (topWin && !isFlat)
    homeDefs.forEach((d, di) => {
      for (let u = d.u0; u <= d.u1; u += 2) {
        const p = planeToWorld(d.plane, u, 0);
        if (!topUV(topWin, p)) continue;
        const t = topAt(outlines[di], u);
        if (t !== null && t > 0) topDatum = Math.min(topDatum, t);
      }
    });
  const plates: PlateInfo[] = [];
  const allParts: Part[] = [];
  const insertOn = input.insert && v.insShape !== 'none';
  // flat stack: registration pins, chosen on the bottom layer, run up until a layer can't hold them
  const pinR = v.pinDia / 2;
  let pins: Vec2[] = [];
  let pinsLive: boolean[] = [];
  let pinTop: number[] = [];
  let below: Shape = []; // material of the layer underneath, for support and guides

  // shelf cards: each plate is trimmed down to just above the bottom edge of the cards it holds
  const seats = seatTops(input.objects, defs, t);

  // candle holders: target fins round each candlestick; slotted ones key into the plates with halving slots
  const fins = (input.candles ?? []).flatMap((c, i) =>
    targetFins(c, c.holder, { t, embed: e, baseTop: baseTop(v), slack: c.slack, minFeature: v.minFeature }, i).map((f) => ({
      f,
      slots: c.holder.slotted ? finSlots(f, defs, { t, candleBottom: c.bottom, baseTop: baseTop(v), engage: c.holder.engage ?? 16, fit: 0.3 }) : [],
    })),
  );
  const finSlotsByPlate = new Map<string, Shape[]>();
  for (const { slots } of fins) for (const s of slots) finSlotsByPlate.set(s.plate, [...(finSlotsByPlate.get(s.plate) ?? []), rect(...s.plateRect)]);

  defs.forEach((def, di) => {
    let shape = outlines[di];
    // choked plates keep only the lengths round the candles (vertical plates; flat layers are left as they are)
    if (input.choke?.length && Math.abs(def.plane.normal[1]) < 0.5 && shape.length) {
      const spans = chokeSpans(def.plane, input.choke, Math.max(6, 2 * v.minFeature));
      shape = spans.length ? intersection(shape, unionShapes(...spans.map(([a, b]) => rect(a, -BIG, b, BIG)))) : [];
    }
    const info: PlateInfo = { def, parts: [], bevel: 0, collision: 0, collisionAt: null, islands: 0, cavity: [], sweptInsert: [], tenons: tenons[di].spans.length };
    if (!shape.length) {
      plates.push(info);
      return;
    }

    // everything removed from the plate is collected and subtracted in one boolean;
    // image-driven cuts go first so their edges can be smoothed on their own
    const cuts: Shape[] = [];
    const imageCuts: Shape[] = [];
    let carveCut: Shape = [];

    // 3. insert cavity, per plate, in 2D
    if (insertOn) {
      const cav = insertCavity(input.insert!, def.plane, t, v.cavityMode, v.clearance);
      if (cav) {
        const { cavity, swept } = cav;
        info.cavity = cavity;
        info.sweptInsert = swept;
        info.bevel = cav.bevel;
        cuts.push(cavity);
        const hit = intersection(cav.sweptOutside, difference(shape, cavity));
        const hitArea = shapeArea(hit);
        if (hitArea > 0.05) {
          info.collision = hitArea;
          const bb = shapeBBox(hit);
          info.collisionAt = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
        }
      }
    }

    // 3b. placed objects: each one's section through the plate, grown by its clearance
    for (const o of input.objects ?? []) {
      if (o.noCut) continue;
      const cav = insertCavity(o.mesh, def.plane, t, 'larger', o.clearance);
      // a thin object crossing at a slant leaves one slit per section; close the slivers between them into one slot
      if (cav) cuts.push(cached(o.mesh, `close:${def.key}:${def.plane.origin.join(',')}:${def.plane.normal.join(',')}:${t}:${o.clearance}`, () => offset(offset(cav.cavity, t, 'round'), -t, 'round')));
    }

    // 4. image-driven front cut-outs
    let etch: Path[] = [];
    if (front) {
      if (v.imgFrontMode !== 'off') {
        const cut = frontCut(homeDefs[di], outlines[di], v, front);
        if (cut.length) imageCuts.push(cut);
      }
      etch = frontEtch(homeDefs[di], v, front);
    }

    // 4b. image impression into the top surface (flat stack: pressed down through the layers)
    if (flat) {
      const cut = flatStampCut(flat, (def.index + 0.5) * t, v.minFeature, t);
      if (cut.length) imageCuts.push(cut);
    } else if (topWin && input.top) {
      const carve = topCarve(homeDefs[di], outlines[di], v, topField!, topWin, Number.isFinite(topDatum) ? topDatum : 0);
      if (carve.length) carveCut = carve;
    }
    if (imageCuts.length) shape = smoothImageCuts(shape, imageCuts.flat(), v.cutSmooth);
    // the top impression rounds its own floor (topCarve), so it is only cut out here
    if (carveCut.length) shape = v.cutSmooth > 0.05 ? simplifyShape(difference(shape, carveCut), SMOOTH_TOL / 2) : difference(shape, carveCut);
    if (seats) shape = difference(shape, seatTrim(seats.plates[di], seats.floor));
    // unobstructed view: push the plate back out of every card's sight line
    if (input.sight) {
      const clear = sightCut(input.sight.cards, input.sight.eye, def.plane, t);
      if (clear.length) shape = difference(shape, clear);
    }
    // all-edges rounding happens before the functional cuts below, so they stay crisp
    if (v.edgeRound > 0.05 || v.edgeRoundIn > 0.05) {
      const before = shape;
      shape = roundAll(shape, v.edgeRound, v.edgeRoundIn);
      // the plate's own end corners always round off the most; the close-up looks along the edge between them
      const bb = shapeBBox(before);
      const endGap = Math.max(v.edgeRound, v.edgeRoundIn) + 3;
      let { move, at } = roundingMove(before, shape, (q) => q[0] < bb.minX + endGap || q[0] > bb.maxX - endGap);
      if (move < 0.05) ({ move, at } = roundingMove(before, shape));
      const pieces = (sh: Shape) => sh.filter((ex) => !(ex.depth ?? 0) && Math.abs(signedArea(ex.outer)) > 0.5).length;
      const label = partLabel(v, def.family, def.index, def.count);
      if (pieces(shape) > pieces(before)) roundSplits.push(label);
      if (move > 0.05) round.spots.push({ key: def.key, label, before, after: shape, at, move });
    }
    // a light opening so no outside corner is sharper than the laser cuts cleanly, and valleys keep half
    // that radius once the kerf offset has eaten into them; no hairline stubs either way. When the
    // user rounds corners themselves, their inside radius stands (0 keeps valleys crisp).
    if (v.minRadius > Math.max(0.05, v.edgeRound)) {
      const blunt = Math.min(0.3, v.minRadius / 2);
      shape = minimumRadius(shape, v.minRadius, v.edgeRound > 0.05 ? blunt : Math.max(v.edgeRoundIn, blunt, v.minRadius / 2 + v.kerf / 2));
    }

    // 5. anchor holes in the embedded tab (any that would run into a rod hole are left out)
    const tune = tuning?.[di] ?? null;
    const rodsHere = rods && def.home ? rodsThrough(rods, def.plane) : rods;
    const rodCut = rodsHere ? rodHoles(rodsHere, { key: def.key, family: def.family, shape: outlines[di] }, v.minFeature) : null;
    if (e > 0 && v.embedMode === 'cast' && v.anchorHoles > 0 && e > v.anchorDia + 2 * v.minFeature) {
      const holes: Path[] = [];
      for (const tr of tabRanges(outlines[di], e)) {
        // fewer holes on a narrow tab, so the web between them never drops below the minimum feature
        let k = v.anchorHoles;
        while (k > 0 && (tr[1] - tr[0]) / (k + 1) - v.anchorDia < 2 * v.minFeature) k--;
        for (let j = 0; j < k; j++) {
          const u = tr[0] + ((j + 1) * (tr[1] - tr[0])) / (k + 1);
          if (rodsHere && rodsHere.rods.some((r) => Math.hypot(r.u - u, r.y + e / 2) < (v.anchorDia + rodsHere.hole) / 2 + v.minFeature)) continue;
          holes.push(circlePath(u, -e / 2, v.anchorDia / 2));
        }
      }
      if (holes.length) {
        cuts.push(holes.map((h) => ({ outer: h, holes: [] })));
      }
    }
    // 5a. free-free bars: a mounting hole at each node of the first bending mode
    if (tune?.model === 'free' && tune.nodes && tune.nodes.length >= 2 && v.tuneHole > 0) {
      const cx = (def.u0 + def.u1) / 2;
      const r = v.tuneHole / 2;
      const y0 = -e;
      cuts.push(tune.nodes.map((s) => ({ outer: circlePath(cx, y0 + s * tune.cut, r), holes: [] })));
    }
    // 5b. threaded rod holes
    if (rodCut && def.family === 'P') {
      if (rodCut.holes.length) cuts.push(rodCut.holes);
      braceIssues.push(...rodCut.issues);
      rodCut.held.forEach((ok, i) => {
        if (ok) return;
        rodMiss[i]++;
        rodMissKey ??= def.key;
      });
    }

    // 5b. flat stack registration pins (through every layer they fit, and on into the base)
    if (flat && v.flatPins > 0) {
      if (def.index === 0) {
        pins = flatPinPoints(v, flat, shape, Math.round(v.flatPins), pinR);
        pinsLive = pins.map(() => true);
        pinTop = pins.map(() => -1);
        if (pins.length < v.flatPins) warnings.push(`Flat stack: room for only ${pins.length} of ${v.flatPins} registration pins.`);
      }
      const holes: Path[] = [];
      pins.forEach((p, k) => {
        if (pinsLive[k] && pinFits(shape, p, pinR, v.minFeature)) {
          holes.push(circlePath(p[0], p[1], pinR));
          pinTop[k] = def.index;
        } else pinsLive[k] = false;
      });
      if (holes.length) cuts.push(holes.map((h) => ({ outer: h, holes: [] })));
    }

    // 6. waffle slots
    if (slots[di].length) cuts.push(slots[di]);
    for (const s of finSlotsByPlate.get(def.key) ?? []) cuts.push(s);
    if (cuts.length) shape = difference(shape, cuts.flat());

    // 7. split into physical pieces; islands inside holes would fall out
    let pieces: ExPoly[] = [];
    for (const ex of shape) {
      // islands inside a flat layer's cut-outs rest on the layer below, so they stay as parts
      if ((ex.depth ?? 0) > 0 && !isFlat) {
        info.islands++;
        continue;
      }
      if (shapeArea([ex]) < 0.5) continue;
      pieces.push(ex);
    }
    pieces.sort((a, b) => {
      const ba = bboxOf([a.outer]), bb = bboxOf([b.outer]);
      return ba.minX + ba.maxX - (bb.minX + bb.maxX);
    });

    const base = partLabel(v, def.family, def.index, def.count);
    const anchoredOf = (ex: ExPoly) => {
      const bb = bboxOf([ex.outer]);
      return isFlat
        ? def.index === 0 || !below.length || shapeArea(intersection([ex], below)) > 1
        : e <= 0 || bb.minY < -0.5;
    };
    const resolved = finishPlatePieces(pieces, {
      v,
      plateKey: def.key,
      plateId: base,
      anchored: anchoredOf,
      below,
      isFlat,
      index: def.index,
    });
    fragmentEvents.push(...resolved.events);
    pieces = resolved.pieces;
    pieces.forEach((ex, pi) => {
      const id = pieces.length > 1 ? `${base}${String.fromCharCode(97 + (pi % 26))}` : base;
      const bb = bboxOf([ex.outer]);
      const lab = labelPlatePiece(id, ex, v, e, tune, def);
      const labelPaths = lab.paths;
      const pieceEtch = etch.length ? clipLines(etch, offset([ex], -0.8)) : [];
      const part: Part = {
        id,
        plateKey: def.key,
        family: def.family,
        index: def.index,
        piece: pi,
        plane: def.plane,
        thickness: t,
        shape: [ex],
        etch: pieceEtch,
        labelPaths,
        labelAt: lab.at,
        area: shapeArea([ex]),
        perimeter: shapePerimeter([ex]),
        bbox: bb,
        anchored: anchoredOf(ex),
        plateId: base,
        kind: 'plate',
      };
      info.parts.push(part);
      allParts.push(part);
    });
    // etch this layer's outline onto the one below, so each layer has a line to glue up to
    if (isFlat && v.flatGuides && def.index > 0 && shape.length) {
      const prev = plates[plates.length - 1];
      const guide = outlinePaths(shape);
      for (const q of prev?.parts ?? []) q.etch = [...q.etch, ...clipLines(guide, offset(q.shape, -0.8))];
    }
    if (isFlat) below = pieces;
    plates.push(info);
  });

  let stackRods: StackRodPlan | null = null;
  if (isFlat && v.stackRodsOn) {
    const islands = plates.flatMap((pl) =>
      pl.def.family !== 'P'
        ? []
        : pl.parts.map((part) => ({
            key: `${pl.def.key}:${part.id}`,
            layer: pl.def.index,
            plateKey: pl.def.key,
            partId: part.id,
            shape: part.shape,
          })),
    );
    const existing = pins
      .map((p, k) => ({ x: p[0], y: p[1], topLayer: pinTop[k] ?? -1, radius: pinR }))
      .filter((c) => c.topLayer >= 0);
    const rodSet = stackRodSettings(v, baseTop(v));
    const p0 = plates.find((pl) => pl.def.family === 'P');
    if (p0) rodSet.plane = p0.def.plane;
    stackRods = placeStackRods(islands, rodSet, existing);
    applyStackRodSmall(allParts, plates, stackRods, rodSet.small, v.kerf);
    const maxLayer = Math.max(0, ...plates.filter((pl) => pl.def.family === 'P').map((pl) => pl.def.index));
    resolveStackRodStickOut(stackRods, allParts, rodSet, maxLayer);
    punchStackRodHoles(allParts, stackRods);
    applyStackRodWorld(
      stackRods,
      plates.filter((pl) => pl.def.family === 'P').map((pl) => ({ index: pl.def.index, plane: pl.def.plane })),
      rodSet,
    );
    for (const part of allParts) {
      if (part.family !== 'P' || !part.shape[0]) continue;
      const di = defs.findIndex((d) => d.key === part.plateKey);
      const lab = labelPlatePiece(part.id, part.shape[0], v, e, tuning?.[di] ?? null, defs[di] ?? null, true);
      part.labelPaths = lab.paths;
      part.labelAt = lab.at;
      if (part.etch.length) part.etch = clipEtchFromFastenerHoles(part.etch, part.shape, LABEL_HOLE_CLEAR_MM, 0.8);
    }
  }

  // 8. the support ring, cut from the same sheet, with a mortise for every tenon
  if (support) {
    const ring = ringShape(support, v, tenons);
    let pieces = ring.filter((ex) => (ex.depth ?? 0) === 0 && shapeArea([ex]) > 0.5);
    const plane = supportPlane(support);
    const base = partLabel(v, 'S', 0, 1);
    const resolved = finishPlatePieces(pieces, { v, plateKey: 'S0', plateId: base, anchored: () => true });
    fragmentEvents.push(...resolved.events);
    pieces = resolved.pieces;
    if (pieces.length > 1) warnings.push(`Support ring falls apart into ${pieces.length} pieces: widen it or raise the slot end land.`);
    const hLab = Math.min(v.labelHeight, (support.outer - support.inner) * 0.4);
    pieces.forEach((ex, pi) => {
      const id = pieces.length > 1 ? `${base}${String.fromCharCode(97 + (pi % 26))}` : base;
      const bb = bboxOf([ex.outer]);
      const lab = placeLabel(id, ex, [0, (support.inner + support.outer) / 2], hLab);
      const part: Part = {
        id,
        plateKey: 'S0',
        family: 'S',
        index: 0,
        piece: pi,
        plane,
        thickness: support.thickness,
        shape: [ex],
        etch: [],
        labelPaths: lab?.paths ?? [],
        labelAt: lab?.at ?? null,
        area: shapeArea([ex]),
        perimeter: shapePerimeter([ex]),
        bbox: bb,
        anchored: true,
        plateId: base,
        kind: 'plate',
      };
      allParts.push(part);
    });
  }

  // 9. laser-cut spacers: cross pieces cast in under the plates and the lift-off spacing template
  rodMiss.forEach((miss, i) => {
    if (!miss) return;
    const r = rods!.rods[i];
    braceIssues.push({ severity: 'warn', plateKey: rodMissKey, message: `The rod at (${r.u.toFixed(0)}, ${r.y.toFixed(0)}) misses ${miss} of ${defs.filter((d) => d.family === 'P').length} plates: they have no steel (or too little) where it runs.` });
  });
  const spacers = buildSpacers(
    v,
    defs,
    plates.map((p) => ({ key: p.def.key, family: p.def.family, plane: p.def.plane, shape: p.parts.map((q) => q.shape[0]) })),
    rods,
    insertOn ? input.insert : null,
    baseTop(v),
    e,
    support ? [support.yBottom - baseTop(v), support.yTop - baseTop(v)] : null,
  );
  if (spacers) {
    braceIssues.push(...spacers.issues);
    for (const sp of spacers.parts) {
      const ex = sp.shape[0];
      const id = partLabel(v, sp.family, sp.index, sp.count);
      const lab = placeLabel(id, ex, sp.labelAt, Math.min(v.labelHeight, sp.labelMax));
      allParts.push({
        id,
        plateKey: sp.key,
        family: sp.family,
        index: sp.index,
        piece: 0,
        plane: sp.plane,
        thickness: t,
        shape: [ex],
        etch: [],
        labelPaths: lab?.paths ?? [],
        labelAt: lab?.at ?? null,
        area: shapeArea([ex]),
        perimeter: shapePerimeter([ex]),
        bbox: bboxOf([ex.outer]),
        anchored: true,
        plateId: id,
        kind: 'plate',
      });
    }
  }
  // 10. candle holders: target fins standing in the concrete round each candlestick
  const unslotted = fins.filter(({ f, slots: fs }) => input.candles![f.holder].holder.slotted && !fs.length).length;
  if (unslotted) warnings.push(`${unslotted} slotted candle fin${unslotted > 1 ? 's run' : ' runs'} along the plates, so ${unslotted > 1 ? 'they have' : 'it has'} nothing to slot into: turn the fins with Spin (45° crosses them all).`);
  fins.forEach(({ f, slots: fs }, j) => {
    const cut = fs.length ? difference(f.shape, unionShapes(...fs.map((s) => rect(...s.finRect)))) : f.shape;
    // keep the biggest piece should a slot ever cut a fin through
    const ex = cut.reduce((a, b) => (shapeArea([b]) > shapeArea([a]) ? b : a), cut[0] ?? f.shape[0]);
    const id = partLabel(v, 'K', j, fins.length);
    const lab = placeLabel(id, ex, f.labelAt, Math.min(v.labelHeight, f.labelMax));
    allParts.push({
      id,
      plateKey: `K${j}`,
      family: 'K',
      index: j,
      piece: 0,
      plane: f.plane,
      thickness: t,
      shape: [ex],
      etch: [],
      labelPaths: lab?.paths ?? [],
      labelAt: lab?.at ?? null,
      area: shapeArea([ex]),
      perimeter: shapePerimeter([ex]),
      bbox: bboxOf([ex.outer]),
      anchored: true,
      kind: 'plate',
    });
  });
  const brace: BraceResult | null = rods || spacers ? { rods, spacers, hardware: rods ? rodHardware(rods) : [], issues: braceIssues } : braceIssues.length ? { rods: null, spacers: null, hardware: [], issues: braceIssues } : null;

  placeLooseParts(allParts, input.moves, new Set(defs.map((d) => d.key)));
  // rounding three times further than its radius (sharper than a 30° point) means detail is being flattened, not just corners eased
  const rMax = Math.max(v.edgeRound, v.edgeRoundIn);
  const spots = round.spots.sort((a, b) => b.move - a.move).slice(0, 6);
  if (spots.length && spots[0].move > Math.max(2, rMax * 3)) warnings.push(`Round all corners flattens detail: the edge of ${spots[0].label} moves ${spots[0].move.toFixed(1)} mm. Lower the radius, or set Inside corners lower.`);
  if (roundSplits.length) warnings.push(`Round all corners cuts through a narrow neck and splits ${roundSplits.slice(0, 4).join(', ')}${roundSplits.length > 4 ? ` and ${roundSplits.length - 4} more` : ''} into pieces.`);
  return { plates, parts: allParts, fragments: fragmentEvents, warnings, front: front ? front.win : null, top: topWin, support, tuning, brace, stackRods, roundSpots: spots };
}
