// Support poles for a flat (Stamped) stack: vertical steel rods through
// islands that would otherwise float, down to the base. One rod is reused
// wherever islands stack. Held islands (on the base, or resting on a held
// island below) do not need their own rod; poles On still places a few
// shared alignment rods for stiffness.
import { circle, circlePath, clipLines, difference, intersection, offset, pointInShape, shapeArea, shapeBBox, shapePerimeter, signedArea, unionShapes, type BBox, type Path, type Shape, type Vec2 } from './geom2d';
import { piecesTouch } from './fragments';
import type { HardwareRow } from './brace';
import type { Values } from './params';
import { planeToWorld, type Plane, type V3 } from './section';

export const STACK_ROD_GRID_MM = 2;
/** Least gap from an etch/label stroke to a hole edge. */
export const LABEL_HOLE_CLEAR_MM = 1.5;
const GLUE_AREA_MM2 = 1;
const ALIGNMENT_MAX = 2;
const OVERLAP_AREA_MM2 = 0.5;

export type StackRodSmall = 'keep' | 'drop' | 'merge';

export interface StackRodIsland {
  key: string;
  layer: number;
  plateKey: string;
  partId: string;
  shape: Shape;
}

/** A column already cut (registration pin) that already holds islands. */
export interface ExistingColumn {
  x: number;
  y: number;
  topLayer: number;
  radius: number;
}

export interface StackRodSettings {
  diameter: number;
  clearance: number;
  edge: number;
  stickOut: number;
  thickness: number;
  minFeature: number;
  baseTop: number;
  small: StackRodSmall;
  /** Plate plane used to turn (x, y) into world ends. */
  plane?: Plane;
}

export interface StackRod {
  id: string;
  x: number;
  y: number;
  diameter: number;
  hole: number;
  length: number;
  topLayer: number;
  layers: number[];
  islands: string[];
  a: V3;
  b: V3;
}

export interface StackRodIssue {
  severity: 'error' | 'warn' | 'info';
  message: string;
  plateKey?: string;
  partId?: string;
  at?: Vec2;
  /** True when glue or the base already holds this island. */
  held?: boolean;
}

export interface StackRodPlan {
  rods: StackRod[];
  hole: number;
  diameter: number;
  issues: StackRodIssue[];
  /** True when every island is already held and the rods are for alignment only. */
  alignmentOnly?: boolean;
}

export interface HoleDisk {
  c: Vec2;
  r: number;
}

/** Minimal part fields the drop/merge pass needs (compatible with slicer `Part`). */
export interface StackRodPart {
  id: string;
  plateKey: string;
  family: string;
  index: number;
  shape: Shape;
  area: number;
  perimeter: number;
  bbox: BBox;
  etch: Path[];
}

const num = (v: Values, id: string, fallback: number) => {
  const x = Number(v[id]);
  return Number.isFinite(x) ? x : fallback;
};

export function stackRodSettings(v: Values, baseTop: number): StackRodSettings {
  const small = String(v.stackRodSmall || 'keep');
  return {
    diameter: num(v, 'stackRodDia', 6),
    clearance: num(v, 'stackRodClearance', 0.5),
    edge: num(v, 'stackRodEdge', 3),
    stickOut: num(v, 'stackRodStickOut', 0),
    thickness: v.thickness,
    minFeature: v.minFeature,
    baseTop,
    small: small === 'drop' || small === 'merge' ? small : 'keep',
  };
}

export function stackRodHoleDia(s: StackRodSettings): number {
  return s.diameter + s.clearance;
}

/** Default flat-stack plane: plate +x east, +y south → world (+X, +Y up, −Z). */
export function defaultStackRodPlane(settings: StackRodSettings): Plane {
  return (
    settings.plane ?? {
      origin: [0, settings.baseTop + settings.thickness / 2, 0],
      normal: [0, 1, 0],
      u: [1, 0, 0],
      v: [0, 0, -1],
    }
  );
}

export function holeDisks(shape: Shape): HoleDisk[] {
  const out: HoleDisk[] = [];
  for (const ex of shape) {
    for (const h of ex.holes) {
      if (h.length < 3) continue;
      let sx = 0, sy = 0;
      for (const q of h) {
        sx += q[0];
        sy += q[1];
      }
      const c: Vec2 = [sx / h.length, sy / h.length];
      const r = Math.sqrt(Math.abs(signedArea(h)) / Math.PI);
      if (r > 0.2) out.push({ c, r });
    }
  }
  return out;
}

/** Round pin/rod holes, not large terrain voids. */
export function fastenerDisks(shape: Shape, maxR = 22): HoleDisk[] {
  const out: HoleDisk[] = [];
  for (const ex of shape) {
    for (const h of ex.holes) {
      if (h.length < 8) continue;
      let sx = 0, sy = 0;
      for (const q of h) {
        sx += q[0];
        sy += q[1];
      }
      const c: Vec2 = [sx / h.length, sy / h.length];
      const r = Math.sqrt(Math.abs(signedArea(h)) / Math.PI);
      if (r < 0.4 || r > maxR) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of h) {
        if (q[0] < minX) minX = q[0];
        if (q[1] < minY) minY = q[1];
        if (q[0] > maxX) maxX = q[0];
        if (q[1] > maxY) maxY = q[1];
      }
      const w = maxX - minX, ht = maxY - minY;
      if (w < 0.5 || ht < 0.5 || Math.max(w, ht) / Math.min(w, ht) > 1.3) continue;
      out.push({ c, r });
    }
  }
  return out;
}

function distPointToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
  return Math.hypot(a[0] + t * vx - p[0], a[1] + t * vy - p[1]);
}

/** True when any open polyline comes within `r` of the disk centre. */
export function pathsHitDisk(paths: Path[], c: Vec2, r: number): boolean {
  if (r <= 0 || !paths.length) return false;
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      if (Math.hypot(a[0] - c[0], a[1] - c[1]) < r) return true;
      if (i + 1 < path.length && distPointToSeg(c, a, path[i + 1]) < r) return true;
    }
  }
  return false;
}

/** Part interior minus an inset and every fastener disk grown by `clear`. */
export function etchKeepOut(shape: Shape, clear = LABEL_HOLE_CLEAR_MM, inset = 0.4): Shape {
  const keep = inset ? offset(shape, -inset) : shape;
  const disks = fastenerDisks(shape);
  if (!disks.length) return keep;
  // Extra 0.1 mm so clipper endpoints sit strictly outside the fit-check radius.
  const avoid = disks.map((d) => ({ outer: circlePath(d.c[0], d.c[1], d.r + clear + 0.1), holes: [] as Path[] }));
  return difference(keep, avoid);
}

/** Clip etch/engrave polylines so they stay `clear` mm from every pin/rod hole. */
export function clipEtchFromFastenerHoles(paths: Path[], shape: Shape, clear = LABEL_HOLE_CLEAR_MM, inset = 0.4): Path[] {
  if (!paths.length) return [];
  const disks = fastenerDisks(shape);
  if (!disks.length && !inset) return paths;
  return clipLines(paths, etchKeepOut(shape, clear, inset));
}

/** Shift etch in +Y off fastener holes when that keeps it on the part, then clip. */
export function nudgeAndClipEtch(paths: Path[], shape: Shape, clear = LABEL_HOLE_CLEAR_MM): Path[] {
  if (!paths.length) return [];
  const disks = fastenerDisks(shape);
  if (!disks.length) return paths;
  const hits = (ps: Path[]) => disks.some((d) => pathsHitDisk(ps, d.c, d.r + clear));
  let shifted = paths;
  if (hits(shifted)) {
    const bb = shapeBBox(shape);
    for (const dy of [2, 4, 6, 8, 12, 16, 24, 32, 48]) {
      const tryP = paths.map((p) => p.map(([x, y]) => [x, y + dy] as Vec2));
      if (tryP.some((p) => p.some((q) => q[1] > bb.maxY - 0.8))) break;
      if (!hits(tryP)) {
        shifted = tryP;
        break;
      }
    }
  }
  return clipEtchFromFastenerHoles(shifted, shape, clear, 0);
}

export function discOverlapsShape(c: Vec2, r: number, shape: Shape, minArea = 0.05): boolean {
  if (r <= 0 || !shape.length) return false;
  return shapeArea(intersection(shape, circle(c[0], c[1], r))) > minArea;
}

function ptKey(p: Vec2): string {
  return `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
}

function islandCentroid(shape: Shape): Vec2 {
  const bb = shapeBBox(shape);
  return [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
}

function islandHasHoleAt(shape: Shape, p: Vec2, r: number): boolean {
  for (const d of holeDisks(shape)) {
    if (Math.hypot(d.c[0] - p[0], d.c[1] - p[1]) < r + 0.6) return true;
  }
  return false;
}

/** Grid points inside an inset region, plus the bbox centre when it sits inside. */
export function sampleInsetGrid(inner: Shape, step = STACK_ROD_GRID_MM): Vec2[] {
  if (!inner.length) return [];
  const bb = shapeBBox(inner);
  if (!Number.isFinite(bb.minX) || bb.maxX - bb.minX < 1e-6 || bb.maxY - bb.minY < 1e-6) {
    const c = islandCentroid(inner);
    return pointInShape(c, inner) ? [c] : [];
  }
  const x0 = Math.ceil(bb.minX / step) * step;
  const y0 = Math.ceil(bb.minY / step) * step;
  const pts: Vec2[] = [];
  for (let y = y0; y <= bb.maxY + 1e-9; y = +(y + step).toFixed(8)) {
    for (let x = x0; x <= bb.maxX + 1e-9; x = +(x + step).toFixed(8)) {
      if (pointInShape([x, y], inner)) pts.push([x, y]);
    }
  }
  const c: Vec2 = [+((bb.minX + bb.maxX) / 2).toFixed(6), +((bb.minY + bb.maxY) / 2).toFixed(6)];
  if (pointInShape(c, inner) && pts.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) > 1e-6)) pts.push(c);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return pts;
}

interface Cand {
  p: Vec2;
  keys: string[];
  topLayer: number;
}

interface Blocked {
  p: Vec2;
  r: number;
}

function tooCloseTo(p: Vec2, b: Blocked, holeR: number, minFeat: number): boolean {
  return Math.hypot(p[0] - b.p[0], p[1] - b.p[1]) < holeR + b.r + minFeat - 1e-6;
}

/**
 * An island is held when it sits on the base (layer 0), a pin already runs
 * through it, or it has glue area on a held island of the layer below.
 */
export function heldIslandKeys(islands: StackRodIsland[], existing: ExistingColumn[] = []): Set<string> {
  const held = new Set<string>();
  if (!islands.length) return held;
  const maxL = Math.max(...islands.map((is) => is.layer));
  const byLayer: StackRodIsland[][] = Array.from({ length: maxL + 1 }, () => []);
  for (const is of islands) byLayer[is.layer].push(is);

  for (const col of existing) {
    for (const is of islands) {
      if (is.layer <= col.topLayer && (islandHasHoleAt(is.shape, [col.x, col.y], col.radius) || pointInShape([col.x, col.y], is.shape))) {
        held.add(is.key);
      }
    }
  }

  for (let layer = 0; layer <= maxL; layer++) {
    for (const is of byLayer[layer]) {
      if (held.has(is.key)) continue;
      if (layer === 0) {
        held.add(is.key);
        continue;
      }
      const below = byLayer[layer - 1].filter((b) => held.has(b.key));
      for (const b of below) {
        if (shapeArea(intersection(is.shape, b.shape)) > GLUE_AREA_MM2) {
          held.add(is.key);
          break;
        }
      }
    }
  }
  return held;
}

function setRodLength(rod: StackRod, length: number, settings: StackRodSettings) {
  rod.length = length;
  const P = defaultStackRodPlane(settings);
  const t = settings.thickness;
  rod.a = planeToWorld(P, rod.x, rod.y, -t / 2);
  rod.b = [rod.a[0] + P.normal[0] * length, rod.a[1] + P.normal[1] * length, rod.a[2] + P.normal[2] * length];
  rod.layers = Array.from({ length: rod.topLayer + 1 }, (_, i) => i);
}

/** World ends from each plate's plane so a u-flip cannot desync 3D from the cut. */
export function applyStackRodWorld(
  plan: StackRodPlan,
  plates: { index: number; plane: Plane }[],
  settings: StackRodSettings,
): void {
  if (!plan.rods.length) return;
  const byI = new Map(plates.map((p) => [p.index, p.plane]));
  const fallback = defaultStackRodPlane(settings);
  const t = settings.thickness;
  for (const rod of plan.rods) {
    const bot = byI.get(0) ?? fallback;
    const top = byI.get(rod.topLayer) ?? bot;
    rod.a = planeToWorld(bot, rod.x, rod.y, -t / 2);
    const extra = rod.length - (rod.topLayer + 1) * t;
    rod.b = planeToWorld(top, rod.x, rod.y, t / 2 + extra);
  }
}

function issueFor(is: StackRodIsland, held: boolean, hole: number, edge: number, small: StackRodSmall): StackRodIssue {
  const bb = shapeBBox(is.shape);
  const at = Number.isFinite(bb.minX) ? ([(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] as Vec2) : undefined;
  if (held) {
    const why = is.layer === 0 ? 'it sits on the base' : 'it rests on a supported island below';
    return {
      severity: small === 'keep' ? 'warn' : 'info',
      held: true,
      plateKey: is.plateKey,
      partId: is.partId,
      at,
      message: `Layer ${is.plateKey} island ${is.partId} is too small for a support rod (Ø${hole.toFixed(1)} mm hole, ${edge} mm from the edge); ${why}.`,
    };
  }
  return {
    severity: small === 'keep' ? 'error' : 'info',
    held: false,
    plateKey: is.plateKey,
    partId: is.partId,
    at,
    message: `Layer ${is.plateKey} island ${is.partId} has no room for a support rod (Ø${hole.toFixed(1)} mm hole, ${edge} mm from the edge) and nothing holds it — it would fall off.`,
  };
}

function pushRod(plan: StackRodPlan, p: Vec2, keys: string[], topLayer: number, settings: StackRodSettings) {
  const length = (topLayer + 1) * settings.thickness + settings.stickOut;
  const rod: StackRod = {
    id: `R${plan.rods.length + 1}`,
    x: p[0],
    y: p[1],
    diameter: settings.diameter,
    hole: plan.hole,
    length,
    topLayer,
    layers: Array.from({ length: topLayer + 1 }, (_, i) => i),
    islands: [...new Set(keys)].sort(),
    a: [p[0], settings.baseTop, -p[1]],
    b: [p[0], settings.baseTop + length, -p[1]],
  };
  setRodLength(rod, length, settings);
  plan.rods.push(rod);
}

/**
 * Greedy set-cover of islands that *need* a pole (floating, with room).
 * Held islands that cannot take a hole warn; floating ones error.
 * When nothing needs a pole, a few shared alignment rods are still placed.
 */
export function placeStackRods(islands: StackRodIsland[], settings: StackRodSettings, existing: ExistingColumn[] = []): StackRodPlan {
  const hole = stackRodHoleDia(settings);
  const holeR = hole / 2;
  const inset = holeR + settings.edge;
  const issues: StackRodIssue[] = [];
  const plan: StackRodPlan = { rods: [], hole, diameter: settings.diameter, issues, alignmentOnly: false };
  if (!islands.length) return plan;

  const sorted = [...islands].sort((a, b) => a.layer - b.layer || a.partId.localeCompare(b.partId) || a.key.localeCompare(b.key));
  const inners = new Map<string, Shape>();
  for (const is of sorted) inners.set(is.key, offset(is.shape, -inset));

  const maxL = Math.max(...sorted.map((is) => is.layer));
  const byLayer: StackRodIsland[][] = Array.from({ length: maxL + 1 }, () => []);
  for (const is of sorted) byLayer[is.layer].push(is);

  const held = heldIslandKeys(sorted, existing);
  const covered = new Set<string>();
  for (const col of existing) {
    for (const is of sorted) {
      if (is.layer <= col.topLayer && islandHasHoleAt(is.shape, [col.x, col.y], col.radius)) covered.add(is.key);
    }
  }

  const minFeat = Math.max(settings.minFeature, 0.5);
  const blocked: Blocked[] = existing.map((c) => ({ p: [c.x, c.y], r: c.radius }));

  const coverAt = (p: Vec2): { keys: string[]; topLayer: number } => {
    const keys: string[] = [];
    let top = -1;
    for (let layer = 0; layer <= maxL; layer++) {
      const hits = byLayer[layer].filter((is) => pointInShape(p, inners.get(is.key) ?? []));
      if (!hits.length) break;
      for (const is of hits) keys.push(is.key);
      top = layer;
    }
    return { keys, topLayer: top };
  };

  const candMap = new Map<string, Cand>();
  for (const is of sorted) {
    if (covered.has(is.key)) continue;
    const inner = inners.get(is.key) ?? [];
    for (const p of sampleInsetGrid(inner)) {
      if (blocked.some((b) => tooCloseTo(p, b, holeR, minFeat))) continue;
      const cov = coverAt(p);
      if (cov.topLayer < is.layer || !cov.keys.includes(is.key)) continue;
      const k = ptKey(p);
      if (!candMap.has(k)) candMap.set(k, { p, keys: [...new Set(cov.keys)], topLayer: cov.topLayer });
    }
  }
  const candidates = [...candMap.values()].sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1]);

  const neededUncovered = () => sorted.filter((is) => !held.has(is.key) && !covered.has(is.key));

  while (neededUncovered().length) {
    let best: Cand | null = null;
    let bestN = 0;
    for (const c of candidates) {
      if (blocked.some((b) => tooCloseTo(c.p, b, holeR, minFeat))) continue;
      const n = c.keys.reduce((a, k) => a + (held.has(k) || covered.has(k) ? 0 : 1), 0);
      if (n === 0) continue;
      const better =
        !best ||
        n > bestN ||
        (n === bestN &&
          (c.topLayer > best.topLayer || (c.topLayer === best.topLayer && (c.p[0] < best.p[0] || (c.p[0] === best.p[0] && c.p[1] < best.p[1])))));
      if (better) {
        best = c;
        bestN = n;
      }
    }
    if (!best || bestN === 0) break;
    for (const k of best.keys) covered.add(k);
    blocked.push({ p: best.p, r: holeR });
    pushRod(plan, best.p, best.keys, best.topLayer, settings);
  }

  for (const is of sorted) {
    if (covered.has(is.key)) continue;
    const inner = inners.get(is.key) ?? [];
    if (held.has(is.key)) {
      if (!inner.length) issues.push(issueFor(is, true, hole, settings.edge, settings.small));
      continue;
    }
    issues.push(issueFor(is, false, hole, settings.edge, settings.small));
  }

  const floatingErr = issues.some((i) => !i.held);
  if (!plan.rods.length && !floatingErr) {
    for (let n = 0; n < ALIGNMENT_MAX; n++) {
      let best: Cand | null = null;
      let bestN = 0;
      for (const c of candidates) {
        if (c.topLayer < 0) continue;
        if (blocked.some((b) => tooCloseTo(c.p, b, holeR, minFeat))) continue;
        const fresh = c.keys.reduce((a, k) => a + (covered.has(k) ? 0 : 1), 0);
        if (fresh === 0) continue;
        const better =
          !best ||
          fresh > bestN ||
          (fresh === bestN &&
            (c.topLayer > best.topLayer || (c.topLayer === best.topLayer && (c.p[0] < best.p[0] || (c.p[0] === best.p[0] && c.p[1] < best.p[1])))));
        if (better) {
          best = c;
          bestN = fresh;
        }
      }
      if (!best || bestN === 0) break;
      for (const k of best.keys) covered.add(k);
      blocked.push({ p: best.p, r: holeR });
      pushRod(plan, best.p, best.keys, best.topLayer, settings);
    }
    if (plan.rods.length) plan.alignmentOnly = true;
  }
  return plan;
}

export function stackRodsUnsupported(plan: StackRodPlan | null | undefined): StackRodIssue[] {
  if (!plan) return [];
  return plan.issues.filter((i) => i.severity === 'error' || i.severity === 'warn');
}

function holeFitsAt(
  shape: Shape,
  p: Vec2,
  holeR: number,
  edge: number,
  blocked: Blocked[],
  minFeat: number,
): boolean {
  const inner = offset(shape, -(holeR + edge));
  if (!pointInShape(p, inner)) return false;
  return !blocked.some((b) => tooCloseTo(p, b, holeR, minFeat));
}

/**
 * Stick-out past the highest layer a rod supports: test the full hole disc
 * against each plate above. Cut a hole when it fits, otherwise clamp so the
 * rod stops at that plate's underside (air above the whole stack is kept).
 */
export function resolveStackRodStickOut(
  plan: StackRodPlan,
  parts: { family: string; index: number; shape: Shape }[],
  settings: StackRodSettings,
  maxLayer: number,
): void {
  if (!plan.rods.length) return;
  const holeR = plan.hole / 2;
  const minFeat = Math.max(settings.minFeature, 0.5);
  const th = settings.thickness;
  for (const rod of plan.rods) {
    const p: Vec2 = [rod.x, rod.y];
    const blocked: Blocked[] = [];
    for (const other of plan.rods) {
      if (other === rod) continue;
      blocked.push({ p: [other.x, other.y], r: plan.hole / 2 });
    }
    let wantedTop = (rod.topLayer + 1) * th + Math.max(0, settings.stickOut);
    for (let layer = rod.topLayer + 1; layer <= maxLayer; layer++) {
      const plateBottom = layer * th;
      if (wantedTop <= plateBottom + 1e-9) break;
      const owners = parts.filter((q) => q.family === 'P' && q.index === layer && discOverlapsShape(p, holeR, q.shape));
      if (owners.length === 0) continue;
      if (owners.length === 1 && holeFitsAt(owners[0].shape, p, holeR, settings.edge, blocked, minFeat)) {
        rod.topLayer = layer;
        continue;
      }
      wantedTop = plateBottom;
      break;
    }
    const minLen = (rod.topLayer + 1) * th;
    setRodLength(rod, Math.max(minLen, wantedTop), settings);
  }
}

export function punchStackRodHoles(
  parts: { family: string; index: number; shape: Shape; area: number; perimeter: number; bbox: BBox }[],
  plan: StackRodPlan,
): void {
  const r = plan.hole / 2;
  if (r <= 0 || !plan.rods.length) return;
  for (const rod of plan.rods) {
    const p: Vec2 = [rod.x, rod.y];
    for (let layer = 0; layer <= rod.topLayer; layer++) {
      const owners = parts.filter((q) => q.family === 'P' && q.index === layer && pointInShape(p, q.shape));
      const part = owners[0];
      if (!part || owners.length !== 1) continue;
      const next = difference(part.shape, [{ outer: circlePath(rod.x, rod.y, r), holes: [] }]);
      if (!next.length) continue;
      part.shape = next.length === 1 ? next : [next.reduce((a, b) => (shapeArea([a]) >= shapeArea([b]) ? a : b))];
      part.area = shapeArea(part.shape);
      part.perimeter = shapePerimeter(part.shape);
      part.bbox = shapeBBox(part.shape);
    }
  }
}

/** Residual rod disc sitting in plate steel after holes are punched. */
export function rodSteelOverlapIssues(
  plan: StackRodPlan,
  parts: { family: string; index: number; id: string; plateKey: string; shape: Shape }[],
  thickness: number,
): StackRodIssue[] {
  const out: StackRodIssue[] = [];
  const r = plan.hole / 2;
  if (r <= 0 || !plan.rods.length) return out;
  for (const rod of plan.rods) {
    for (const part of parts) {
      if (part.family !== 'P') continue;
      const lo = part.index * thickness;
      if (rod.length <= lo + 1e-6) continue;
      const area = shapeArea(intersection(part.shape, circle(rod.x, rod.y, r)));
      if (area <= OVERLAP_AREA_MM2) continue;
      out.push({
        severity: 'error',
        plateKey: part.plateKey,
        partId: part.id,
        at: [rod.x, rod.y],
        message: `Rod ${rod.id} overlaps steel on ${part.id} (${area.toFixed(1)} mm²) — cut a hole or shorten the stick-out.`,
      });
    }
  }
  return out;
}

function removePart(allParts: StackRodPart[], plates: { def: { key: string }; parts: StackRodPart[] }[], part: StackRodPart) {
  const i = allParts.indexOf(part);
  if (i >= 0) allParts.splice(i, 1);
  for (const pl of plates) {
    const j = pl.parts.indexOf(part);
    if (j >= 0) pl.parts.splice(j, 1);
  }
}

function tryUnionOne(a: Shape, b: Shape, pads: number[]): Shape | null {
  const direct = unionShapes(a, b);
  if (direct.length === 1 && shapeArea(direct) > 0.5) return direct;
  for (const pad of pads) {
    if (pad <= 0) continue;
    const closed = offset(offset(unionShapes(a, b), pad), -pad);
    if (closed.length === 1 && shapeArea(closed) > 0.5) return closed;
  }
  return null;
}

function adoptShape(part: StackRodPart, shape: Shape) {
  part.shape = shape;
  part.area = shapeArea(shape);
  part.perimeter = shapePerimeter(shape);
  part.bbox = shapeBBox(shape);
}

function partDist(a: StackRodPart, b: StackRodPart): number {
  const ca = islandCentroid(a.shape);
  const cb = islandCentroid(b.shape);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}

/**
 * Drop or merge islands that need a pole and cannot take a hole.
 * Held islands are never touched. Merge unions into a same-layer neighbour
 * or into a part on the layer below; it never falls back to drop.
 */
export function applyStackRodSmall(
  allParts: StackRodPart[],
  plates: { def: { key: string }; parts: StackRodPart[] }[],
  plan: StackRodPlan,
  mode: StackRodSmall,
  kerf: number,
): void {
  if (mode === 'keep' || !plan.issues.length) return;
  const pad = Math.max(0.2, kerf);
  const weldPads = [0, pad, 2, 4, 8, 12];
  const leftover: StackRodIssue[] = [];
  for (const issue of plan.issues) {
    if (issue.held) {
      leftover.push(issue);
      continue;
    }
    const part = allParts.find((p) => p.id === issue.partId && p.plateKey === issue.plateKey);
    if (!part) {
      leftover.push(issue);
      continue;
    }
    if (mode === 'merge') {
      const plate = plates.find((pl) => pl.def.key === part.plateKey);
      const siblings = (plate?.parts ?? []).filter((p) => p !== part);
      const touching = siblings.filter((s) => part.shape[0] && s.shape[0] && piecesTouch(part.shape[0], s.shape[0], pad));
      const sameLayer = [
        ...touching.slice().sort((a, b) => b.area - a.area),
        ...siblings.filter((s) => !touching.includes(s)).sort((a, b) => partDist(a, part) - partDist(b, part) || b.area - a.area),
      ];
      let host: StackRodPart | null = null;
      for (const best of sameLayer) {
        const merged = tryUnionOne(best.shape, part.shape, weldPads);
        if (!merged) continue;
        adoptShape(best, merged);
        best.etch = [...best.etch, ...part.etch];
        host = best;
        break;
      }
      if (!host) {
        const below = allParts.filter((p) => p !== part && p.family === part.family && p.index === part.index - 1);
        const overlapping = below.filter((b) => shapeArea(intersection(part.shape, b.shape)) > 0);
        const belowOrdered = [
          ...overlapping.slice().sort((a, b) => b.area - a.area),
          ...below.filter((b) => !overlapping.includes(b)).sort((a, b) => partDist(a, part) - partDist(b, part) || b.area - a.area),
        ];
        for (const best of belowOrdered) {
          const merged = tryUnionOne(best.shape, part.shape, weldPads);
          if (!merged) continue;
          adoptShape(best, merged);
          best.etch = [...best.etch, ...part.etch];
          host = best;
          break;
        }
      }
      if (host) {
        removePart(allParts, plates, part);
        leftover.push({
          ...issue,
          severity: 'info',
          message: `Merged ${part.id} into ${host.id} (too small for a support rod).`,
        });
        continue;
      }
      leftover.push(issue);
      continue;
    }
    removePart(allParts, plates, part);
    leftover.push({
      ...issue,
      severity: 'info',
      message: `Dropped ${part.id} (too small for a support rod).`,
    });
  }
  plan.issues = leftover;
}

export function stackRodsCsv(plan: StackRodPlan): string {
  const lines = ['rod_id,diameter_mm,length_mm'];
  for (const r of plan.rods) lines.push([r.id, r.diameter.toFixed(2), r.length.toFixed(2)].join(','));
  return lines.join('\n') + '\n';
}

export function stackRodHardware(plan: StackRodPlan | null | undefined): HardwareRow[] {
  if (!plan?.rods.length) return [];
  const groups = new Map<string, StackRod[]>();
  for (const r of plan.rods) {
    const k = `${r.diameter}|${r.length.toFixed(3)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows: HardwareRow[] = [];
  for (const rods of groups.values()) {
    const r = rods[0];
    rows.push({
      item: 'Support rod',
      spec: `Ø${r.diameter} × ${r.length.toFixed(0)} mm steel`,
      qty: rods.length,
      note: 'vertical pole through the flat stack, down to the base',
      kind: 'rod',
      metres: rods.reduce((a, x) => a + x.length, 0) / 1000,
    });
  }
  return rows;
}
