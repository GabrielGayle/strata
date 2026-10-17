// Support poles for a flat (Stamped) stack: vertical steel rods through every
// connected island, down to the base, reusing one rod wherever islands stack.
import { circlePath, difference, offset, pointInShape, shapeArea, shapeBBox, shapePerimeter, type BBox, type Shape, type Vec2 } from './geom2d';
import type { HardwareRow } from './brace';
import type { Values } from './params';
import type { V3 } from './section';

export const STACK_ROD_GRID_MM = 2;

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
  severity: 'error';
  message: string;
  plateKey?: string;
  partId?: string;
  at?: Vec2;
}

export interface StackRodPlan {
  rods: StackRod[];
  hole: number;
  diameter: number;
  issues: StackRodIssue[];
}

const num = (v: Values, id: string, fallback: number) => {
  const x = Number(v[id]);
  return Number.isFinite(x) ? x : fallback;
};

export function stackRodSettings(v: Values, baseTop: number): StackRodSettings {
  return {
    diameter: num(v, 'stackRodDia', 6),
    clearance: num(v, 'stackRodClearance', 0.5),
    edge: num(v, 'stackRodEdge', 3),
    stickOut: num(v, 'stackRodStickOut', 0),
    thickness: v.thickness,
    minFeature: v.minFeature,
    baseTop,
  };
}

export function stackRodHoleDia(s: StackRodSettings): number {
  return s.diameter + s.clearance;
}

function ptKey(p: Vec2): string {
  return `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
}

function islandCentroid(shape: Shape): Vec2 {
  const bb = shapeBBox(shape);
  return [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
}

function islandHasHoleAt(shape: Shape, p: Vec2, r: number): boolean {
  for (const ex of shape) {
    for (const h of ex.holes) {
      if (!h.length) continue;
      let sx = 0, sy = 0;
      for (const q of h) {
        sx += q[0];
        sy += q[1];
      }
      const c: Vec2 = [sx / h.length, sy / h.length];
      if (Math.hypot(c[0] - p[0], c[1] - p[1]) < r + 0.6) return true;
    }
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
 * Greedy set-cover of islands by vertical columns. A column may only cross
 * solid material (with the hole + min edge distance) from the base up.
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
    const bb = shapeBBox(is.shape);
    issues.push({
      severity: 'error',
      message: `Layer ${is.plateKey} island ${is.partId} has no room for a support rod (Ø${hole.toFixed(1)} mm hole, ${settings.edge} mm from the edge).`,
      plateKey: is.plateKey,
      partId: is.partId,
      at: Number.isFinite(bb.minX) ? [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] : undefined,
    });
  }
  return plan;
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
