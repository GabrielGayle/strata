// CNC moulds for the concrete: stacked plywood rings (split to release),
// a floor board, and a jig that holds the plates at pitch during the pour.
import {
  bboxOf,
  circlePath,
  difference,
  intersection,
  offset,
  rect,
  shapeArea,
  shapeBBox,
  union,
  unionShapes,
  type Path,
  type Shape,
  BIG,
} from './geom2d';
import type { Values } from './params';
import { sectionShape, type Plane } from './section';
import type { IndexedMesh } from './forms';
import type { SliceResult } from './slicer';
import { baseTop, embedOf } from './slicer';
import { evaluate, parse } from './expr';
import { baseChamfers, baseVolumeBetween, basePlan } from './base';

export interface MouldPart {
  id: string;
  body: 'base' | 'insert';
  kind: 'ring' | 'floor' | 'jig' | 'cap';
  /** Plan shape in top view coordinates (x, -z). One ExPoly. */
  shape: Shape;
  y0: number; // world height of the bottom face (as assembled)
  thickness: number;
  area: number;
}

export interface MouldResult {
  parts: MouldPart[];
  notes: string[];
  dowels: number;
  bolts: number;
}

export interface PourLayer {
  id: string;
  name: string;
  height: string; // expression
  color: string;
}

export interface PourPlanRow {
  id: string;
  name: string;
  color: string;
  y0: number;
  y1: number;
  height: number;
  volume: number; // litres
  mass: number; // kg
  error?: string;
}

const CONCRETE_DENSITY = 2400; // kg/m³

/** Horizontal plane at world height y; plan coords are (x, -z). */
function horizPlane(y: number): Plane {
  return { origin: [0, y, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] };
}

function splitHalves(s: Shape, axis: 'x' | 'y', at: number): Shape[] {
  const big = BIG;
  const a = axis === 'x' ? rect(-big, -big, at, big) : rect(-big, -big, big, at);
  const b = axis === 'x' ? rect(at, -big, big, big) : rect(-big, at, big, big);
  return [intersection(s, a), intersection(s, b)].filter((x) => x.length);
}

interface RingOpts {
  outer: [number, number, number, number]; // x0, y0, x1, y1 of the mould block
  v: Values;
}

function tabsAndDowels({ outer, v }: RingOpts): { tabs: Shape; tabHoles: Path[]; dowels: Path[] } {
  const [x0, y0, x1, y1] = outer;
  const ts = v.tabSize;
  const tabs: Path[] = [];
  const tabHoles: Path[] = [];
  const hole = v.dowelDia / 2;
  const nL = Math.round(v.tabsPerSide);
  const nS = nL > 0 ? Math.max(1, Math.round(nL * ((y1 - y0) / (x1 - x0)))) : 0;
  const proj = ts * 0.6;
  for (let i = 0; i < nL; i++) {
    const cx = x0 + ((i + 1) * (x1 - x0)) / (nL + 1);
    tabs.push(...rect(cx - ts / 2, y1 - 1, cx + ts / 2, y1 + proj).map((e) => e.outer));
    tabs.push(...rect(cx - ts / 2, y0 - proj, cx + ts / 2, y0 + 1).map((e) => e.outer));
    tabHoles.push(circlePath(cx, y1 + proj / 2, hole), circlePath(cx, y0 - proj / 2, hole));
  }
  for (let i = 0; i < nS; i++) {
    const cy = y0 + ((i + 1) * (y1 - y0)) / (nS + 1);
    tabs.push(...rect(x1 - 1, cy - ts / 2, x1 + proj, cy + ts / 2).map((e) => e.outer));
    tabs.push(...rect(x0 - proj, cy - ts / 2, x0 + 1, cy + ts / 2).map((e) => e.outer));
    tabHoles.push(circlePath(x1 + proj / 2, cy, hole), circlePath(x0 - proj / 2, cy, hole));
  }
  const inset = v.mouldWall / 2;
  const dowels: Path[] = [];
  const dx = [x0 + inset, (x0 * 3 + x1) / 4, (x0 + x1 * 3) / 4, x1 - inset];
  for (const x of dx) dowels.push(circlePath(x, y0 + inset, hole), circlePath(x, y1 - inset, hole));
  dowels.push(circlePath(x0 + inset, (y0 + y1) / 2, hole), circlePath(x1 - inset, (y0 + y1) / 2, hole));
  return { tabs: tabs.length ? union(tabs) : [], tabHoles, dowels };
}

function stackedMould(
  body: 'base' | 'insert',
  prefix: string,
  cavities: { y0: number; shape: Shape }[],
  v: Values,
  splitAxis: 'x' | 'y',
  out: MouldPart[],
  floor: { y0: number; kind: 'floor' | 'cap' },
): { dowels: number; bolts: number } {
  if (!cavities.length) return { dowels: 0, bolts: 0 };
  const ply = v.plyThickness;
  const all = cavities.flatMap((c) => c.shape.map((e) => e.outer));
  const bb = bboxOf(all);
  const W = v.mouldWall;
  const outerBox: [number, number, number, number] = [bb.minX - W, bb.minY - W, bb.maxX + W, bb.maxY + W];
  const { tabs, tabHoles, dowels } = tabsAndDowels({ outer: outerBox, v });
  const block = unionShapes(rect(...outerBox), tabs);
  const drilled = difference(block, union([...tabHoles, ...dowels]));
  const splitAt = splitAxis === 'x' ? (bb.minX + bb.maxX) / 2 : (bb.minY + bb.maxY) / 2;
  cavities.forEach((c, k) => {
    const ring = difference(drilled, c.shape);
    const pieces = v.mouldSplit === 'halves' ? splitHalves(ring, splitAxis, splitAt) : [ring];
    pieces.forEach((piece, pi) => {
      for (const ex of piece) {
        if (shapeArea([ex]) < 1) continue;
        out.push({
          id: `${prefix}L${String(k + 1).padStart(2, '0')}${pieces.length > 1 ? String.fromCharCode(97 + pi) : ''}${piece.length > 1 ? `-${piece.indexOf(ex) + 1}` : ''}`,
          body,
          kind: 'ring',
          shape: [ex],
          y0: c.y0,
          thickness: ply,
          area: shapeArea([ex]),
        });
      }
    });
  });
  const fl = drilled;
  for (const ex of fl)
    out.push({ id: `${prefix}${floor.kind === 'floor' ? 'FLOOR' : 'CAP'}`, body, kind: floor.kind, shape: [ex], y0: floor.y0, thickness: ply, area: shapeArea([ex]) });
  return { dowels: dowels.length, bolts: tabHoles.length };
}

export function buildMoulds(v: Values, sliced: SliceResult, insert: IndexedMesh | null, insertBox: { minY: number; maxY: number } | null): MouldResult {
  const parts: MouldPart[] = [];
  const notes: string[] = [];
  let dowels = 0;
  let bolts = 0;
  if (!v.mouldOn) return { parts, notes, dowels, bolts };
  const ply = v.plyThickness;

  // --- base mould -------------------------------------------------------
  if (v.baseOn) {
    const L = v.baseLength, Wd = v.baseWidth, H = v.baseHeight;
    const n = Math.ceil(H / ply - 1e-6);
    const proud = n * ply - H;
    if (proud > 0.01) notes.push(`Base: ${n} layers of ${ply} mm ply; top layer stands ${proud.toFixed(1)} mm proud. Mark a fill line at ${H} mm.`);
    else notes.push(`Base: ${n} layers of ${ply} mm ply, flush with the ${H} mm base.`);
    const tanD = Math.tan((v.draft * Math.PI) / 180);
    const cavities = [];
    for (let k = 0; k < n; k++) {
      const yTop = Math.min(H, (k + 1) * ply);
      const d = tanD * yTop;
      cavities.push({ y0: k * ply, shape: sliced.baseOutline ? offset(sliced.baseOutline, -d, 'round', 0.1) : union([basePlan(v, -d)]) });
    }
    const ch = baseChamfers(v);
    if (ch.corner > 0) notes.push(`Base corners chamfered ${ch.corner.toFixed(0)} mm: cut into every ring.`);
    if (ch.edge > 0) notes.push(`Top edge chamfer ${ch.edge.toFixed(0)} mm: fix a ${ch.edge.toFixed(0)} mm 45° chamfer strip around the inside of the top ring, its lower edge ${(H - ch.edge).toFixed(0)} mm up, and trowel the top flush with its inner edge.`);
    const sup = sliced.support;
    if (sup) {
      notes.push(
        `Support ring: pour the first ${Math.max(0, H + sup.tenonBottom).toFixed(0)} mm, let it stiffen, then lower the plates (tenons through the ring) so the ring's top face sits ${sup.depth.toFixed(0)} mm below the surface; pour the rest.`,
      );
    }
    const br = sliced.brace;
    if (br?.rods) {
      const rp = br.rods;
      const cast = rp.rods.filter((r) => r.embedded).length;
      const steel = rp.rods.length - cast;
      const where = [cast && `${cast} cast in`, steel && `${steel} through the exposed steel`].filter(Boolean).join(', ');
      notes.push(`Threaded rods: ${rp.rods.length} × ${rp.size} (${where}). Thread the plates on in order with their nuts and washers, square the stack, then tighten before the pour.`);
    }
    const cross = br?.spacers?.parts.filter((p) => p.family === 'C') ?? [];
    const tmpl = br?.spacers?.parts.filter((p) => p.family === 'T') ?? [];
    if (cross.length) notes.push(`Cross pieces: stand the ${cross.length} combs on the first pour, drop every plate's tab into its slots, and pour over them; they stay in the concrete.`);
    if (tmpl.length) notes.push(`Spacing template: lower the ${tmpl.length} template${tmpl.length > 1 ? 's' : ''} over the plate tops so each plate sits in its slot; lift ${tmpl.length > 1 ? 'them' : 'it'} straight off once the concrete has cured.`);
    const r = stackedMould('base', 'MB-', cavities, v, 'x', parts, { y0: -ply, kind: 'floor' });
    dowels += r.dowels;
    bolts += r.bolts;

    // jig: slots that hold each plate at its pitch while the concrete cures
    if (v.jigOn && sliced.plates.length) {
      if (v.sliceMode === 'flat') notes.push('Jig skipped for the flat stack: it sits on the cured base. Set pins or threaded rod in the wet concrete at the registration holes (use the bottom layer as a template).');
      else if (v.sliceMode === 'waffle') notes.push('Jig skipped for waffle slicing: the slot grid would split the board. Brace the waffle as one assembly.');
      else {
        const e = embedOf(v);
        const c = v.jigClearance;
        const slots: Path[] = [];
        for (const pl of sliced.plates) {
          const tabParts = pl.parts.filter((p) => p.bbox.minY < 0);
          if (!tabParts.length) continue;
          const u0 = Math.min(...tabParts.map((p) => p.bbox.minX)) - c;
          const u1 = Math.max(...tabParts.map((p) => p.bbox.maxX)) + c;
          const P = pl.def.plane;
          const hw = v.thickness / 2 + c;
          const pt = (u: number, w: number): [number, number] => {
            const x = P.origin[0] + P.u[0] * u + P.normal[0] * w;
            const z = P.origin[2] + P.u[2] * u + P.normal[2] * w;
            return [x, -z];
          };
          slots.push([pt(u0, -hw), pt(u1, -hw), pt(u1, hw), pt(u0, hw)]);
        }
        const bb = [-L / 2 - v.mouldWall, -Wd / 2 - v.mouldWall, L / 2 + v.mouldWall, Wd / 2 + v.mouldWall] as const;
        let jig = difference(rect(bb[0], bb[1], bb[2], bb[3]), union(slots));
        if (insert && v.insShape !== 'none' && insertBox) {
          const y = Math.max(insertBox.minY + 0.5, baseTop(v) + 1);
          const sec = sectionShape(insert, horizPlane(y));
          if (sec.length) jig = difference(jig, offset(sec, v.clearance + 3));
        }
        const pieces = jig.filter((ex) => shapeArea([ex]) > 100);
        pieces.forEach((ex, i) => parts.push({ id: `MB-JIG${pieces.length > 1 ? `-${i + 1}` : ''}`, body: 'base', kind: 'jig', shape: [ex], y0: H + Math.max(0, n * ply - H), thickness: ply, area: shapeArea([ex]) }));
        if (pieces.length > 1) notes.push(`Jig splits into ${pieces.length} pieces; screw them to a frame before use.`);
        if (e > 0) notes.push(`Plates sink ${e} mm into the concrete; the jig holds them at pitch while it cures.`);
      }
    }
  }

  // --- insert mould -----------------------------------------------------
  if (insert && insertBox && v.insShape !== 'none' && v.insMaterial === 'concrete') {
    const y0 = insertBox.minY;
    const y1 = insertBox.maxY;
    const n = Math.ceil((y1 - y0) / ply - 1e-6);
    const cav: { y0: number; shape: Shape }[] = [];
    for (let k = 0; k < n; k++) {
      const a = y0 + k * ply;
      const b = Math.min(y1, a + ply);
      // larger of the layer's bottom and top sections, so the cast can be sanded back to the true form
      const s = unionShapes(sectionShape(insert, horizPlane(a + 0.05)), sectionShape(insert, horizPlane(b - 0.05)));
      if (s.length) cav.push({ y0: a, shape: s });
    }
    if (cav.length) {
      const bb = shapeBBox(cav.flatMap((c) => c.shape));
      const axis = bb.maxX - bb.minX >= bb.maxY - bb.minY ? 'y' : 'x';
      const r = stackedMould('insert', 'MI-', cav, v, axis, parts, { y0: y1, kind: 'cap' });
      dowels += r.dowels;
      bolts += r.bolts;
      notes.push(`Insert: ${cav.length} stepped layers. Cast inverted, pouring through the open bottom face; sand the steps back to the form.`);
    }
  }
  return { parts, notes, dowels, bolts };
}

export function pourPlan(v: Values, layers: PourLayer[], scope: Record<string, number>, outline?: Shape | null): { rows: PourPlanRow[]; total: number; mismatch: number } {
  const rows: PourPlanRow[] = [];
  let y = 0;
  for (const l of layers) {
    let h = 0;
    let error: string | undefined;
    try {
      h = evaluate(parse(l.height), scope);
      if (!Number.isFinite(h) || h < 0) throw new Error('Invalid height');
    } catch (e) {
      error = (e as Error).message;
      h = 0;
    }
    const vol = baseVolumeBetween(v, y, y + h, outline) / 1e9; // m³
    rows.push({ id: l.id, name: l.name, color: l.color, y0: y, y1: y + h, height: h, volume: vol * 1000, mass: vol * CONCRETE_DENSITY, error });
    y += h;
  }
  return { rows, total: y, mismatch: y - v.baseHeight };
}
