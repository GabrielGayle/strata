// Support poles for a flat (Stamped) stack: vertical steel rods through
// islands that would otherwise float, down to the base. One rod is reused
// wherever islands stack. Held islands (on the base, or resting on a held
// island below) do not need their own rod.
import { circlePath, difference, intersection, offset, pointInShape, shapeArea, shapeBBox, shapePerimeter, signedArea, unionShapes, type BBox, type Path, type Shape, type Vec2 } from './geom2d';
import { piecesTouch } from './fragments';
import type { HardwareRow } from './brace';
import type { Values } from './params';
import type { V3 } from './section';

export const STACK_ROD_GRID_MM = 2;
/** Least gap from an etch/label stroke to a hole edge. */
export const LABEL_HOLE_CLEAR_MM = 1.5;
const GLUE_AREA_MM2 = 1;

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
  rod.a = [rod.x, settings.baseTop, -rod.y];
  rod.b = [rod.x, settings.baseTop + length, -rod.y];
  rod.layers = Array.from({ length: rod.topLayer + 1 }, (_, i) => i);
}

function issueFor(is: StackRodIsland, held: boolean, hole: number, edge: number, small: StackRodSmall): StackRodIssue {
  const bb = shapeBBox(is.shape);
  const at = Number.isFinite(bb.minX) ? [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] as Vec2 : undefined;
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

/**
 * Greedy set-cover of islands by vertical columns. A column may only cross
 * solid material (with the hole + min edge distance) from the base up.
 * Held islands that cannot take a hole warn (or drop/merge); floating ones error.
 */
export function placeStackRods(islands: StackRodIsland[], settings: StackRodSettings, existing: ExistingColumn[] = []): StackRodPlan {
  const hole = stackRodHoleDia(settings);
  const holeR = hole / 2;
  const inset = holeR + settings.edge;
  const issues: StackRodIssue[] = [];
  const plan: StackRodPlan = { rods: [], hole, diameter: settings.diameter, issues };
  if (!islands.length) return plan;

  const sorted = [...islands].sort((a, b) => a.layer - b.layer || a.partId.localeCompare(b.partId) || a.key.localeCompare(b.key));
  const inners = new Map<string, Shape>();
  for (const is of sorted) inners.set(is.key, offset(is.shape, -inset));

  const maxL = Math.max(...sorted.map((is) => is.layer));
  const byLayer: StackRodIsland[][] = Array.from({ length: maxL + 1 }, () => []);
  for (const is of sorted) byLayer[is.layer].push(is);

  const held = heldIslandKeys(sorted, existing);
  // Pins already count as covering. Held-by-glue islands do not *need* a rod,
  // but greedy still places one through any island that has room (peaks).
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

  const uncovered = () => sorted.filter((is) => !covered.has(is.key));

  while (uncovered().length) {
    let best: Cand | null = null;
    let bestN = 0;
    for (const c of candidates) {
      if (blocked.some((b) => tooCloseTo(c.p, b, holeR, minFeat))) continue;
      const n = c.keys.reduce((a, k) => a + (covered.has(k) ? 0 : 1), 0);
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
    const topLayer = best.topLayer;
    const length = (topLayer + 1) * settings.thickness + settings.stickOut;
    const id = `R${plan.rods.length + 1}`;
    const x = best.p[0];
    const y = best.p[1];
    plan.rods.push({
      id,
      x,
      y,
      diameter: settings.diameter,
      hole,
      length,
      topLayer,
      layers: Array.from({ length: topLayer + 1 }, (_, i) => i),
      islands: [...new Set(best.keys)].sort(),
      a: [x, settings.baseTop, -y],
      b: [x, settings.baseTop + length, -y],
    });
  }

  for (const is of uncovered()) {
    issues.push(issueFor(is, held.has(is.key), hole, settings.edge, settings.small));
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
 * Stick-out past the highest layer a rod supports: cut a hole through any
 * plate it would enter when the hole fits, otherwise clamp so it stops at
 * that plate's underside (air above the whole stack is kept).
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
      const owners = parts.filter((q) => q.family === 'P' && q.index === layer && pointInShape(p, q.shape));
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

function removePart(allParts: StackRodPart[], plates: { def: { key: string }; parts: StackRodPart[] }[], part: StackRodPart) {
  const i = allParts.indexOf(part);
  if (i >= 0) allParts.splice(i, 1);
  for (const pl of plates) {
    const j = pl.parts.indexOf(part);
    if (j >= 0) pl.parts.splice(j, 1);
  }
}

/**
 * Drop or merge islands that cannot take a hole. Keep mode leaves the issues.
 * A successful drop/merge clears the error/warning so export can proceed,
 * except we never leave a floating island in place.
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
  const leftover: StackRodIssue[] = [];
  for (const issue of plan.issues) {
    const part = allParts.find((p) => p.id === issue.partId && p.plateKey === issue.plateKey);
    if (!part) {
      leftover.push(issue);
      continue;
    }
    const plate = plates.find((pl) => pl.def.key === part.plateKey);
    const siblings = (plate?.parts ?? []).filter((p) => p !== part);
    if (mode === 'merge' && siblings.length) {
      const touching = siblings.filter((s) => part.shape[0] && s.shape[0] && piecesTouch(part.shape[0], s.shape[0], pad));
      const best = (touching.length ? touching : siblings).slice().sort((a, b) => b.area - a.area)[0];
      if (best) {
        const merged = unionShapes(best.shape, part.shape);
        if (merged.length) {
          best.shape = merged.length === 1 ? merged : [merged.reduce((a, b) => (shapeArea([a]) >= shapeArea([b]) ? a : b))];
          best.area = shapeArea(best.shape);
          best.perimeter = shapePerimeter(best.shape);
          best.bbox = shapeBBox(best.shape);
          best.etch = [...best.etch, ...part.etch];
          removePart(allParts, plates, part);
          leftover.push({
            ...issue,
            severity: 'info',
            message: `Merged ${part.id} into ${best.id} (too small for a support rod).`,
          });
          continue;
        }
      }
    }
    // drop, or merge fallback
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
