// Fabrication fit checks: everything that would make a part uncuttable or
// make it not fit once it's cut.
import { difference, pointInShape, shapeArea, shapeBBox, signedArea, type Shape, type Vec2 } from './geom2d';
import { cached } from './memo';
import type { Values } from './params';
import type { Part, SliceResult } from './slicer';
import { formatFragment, kerfGapRegions, morphOpen } from './fragments';
import { planeToWorld, type V3 } from './section';
import { baseChamfers, planClearance } from './base';

export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
  partId: string | null;
  plateKey?: string;
  type: 'thin' | 'gap' | 'small' | 'collision' | 'island' | 'unanchored' | 'hole' | 'sheet' | 'bevel' | 'label' | 'fragment' | 'general' | 'rod';
  severity: Severity;
  message: string;
  at?: Vec2;
  region?: Shape;
}

function regions(s: Shape, minArea: number): Shape[] {
  return s.filter((e) => shapeArea([e]) > minArea).map((e) => [e]);
}

// The two morphology checks are the expensive part; they are cached on the part's
// shape, which the pipeline keeps identical for parts an edit didn't change.
const thinRegions = (s: Shape, mf: number) =>
  cached(s, `thin:${mf}`, () => regions(difference(s, morphOpen(s, mf)), mf * mf * 0.6));
const gapRegions = (s: Shape, kerf: number) => cached(s, `gap:${kerf}`, () => kerfGapRegions(s, kerf).map((e) => [e]));
/** Thinnest concrete floor left under the embedded plates before it is likely to crack. */
export const MIN_FLOOR = 5;

// Limits that only bite on small pieces, where the base gets thin and the
// embedded tab gets too shallow for anchor holes.
function baseChecks(v: Values): Issue[] {
  const issues: Issue[] = [];
  if (!v.baseOn || v.embedDepth <= 0) return issues;
  const floor = v.baseHeight - v.embedDepth;
  if (floor <= 0) {
    issues.push({ partId: null, type: 'general', severity: 'error', message: `Plates are embedded ${v.embedDepth} mm into a ${v.baseHeight} mm base: they go straight through.` });
  } else if (floor < MIN_FLOOR) {
    issues.push({ partId: null, type: 'general', severity: 'warn', message: `Only ${floor.toFixed(1)} mm of concrete under the plates (min ${MIN_FLOOR}). Raise the base or embed less.` });
  }
  if (v.embedMode === 'cast' && v.anchorHoles > 0 && v.embedDepth <= v.anchorDia + 2 * v.minFeature) {
    issues.push({
      partId: null,
      type: 'hole',
      severity: 'warn',
      message: `Embedded tab (${v.embedDepth} mm) is too shallow for Ø${v.anchorDia} mm anchor holes, so they are left out. Embed deeper, use a smaller hole, or cast slots and glue.`,
    });
  }
  return issues;
}

export function runChecks(v: Values, sliced: SliceResult): Issue[] {
  const issues: Issue[] = [];
  const mf = v.minFeature;
  const kerf = v.kerf;
  const sheetMax = Math.max(v.sheetW, v.sheetH);
  const sheetMin = Math.min(v.sheetW, v.sheetH);
  issues.push(...baseChecks(v));

  for (const plate of sliced.plates) {
    if (plate.collision > 0) {
      issues.push({
        partId: plate.parts[0]?.id ?? null,
        plateKey: plate.def.key,
        type: 'collision',
        severity: 'error',
        message: `Insert collides with plate (${plate.collision.toFixed(1)} mm²). Use "Larger" cavity or more clearance.`,
        at: plate.collisionAt ?? undefined,
      });
    }
    if (plate.islands > 0) {
      issues.push({
        partId: plate.parts[0]?.id ?? null,
        plateKey: plate.def.key,
        type: 'island',
        severity: 'warn',
        message: `${plate.islands} island(s) inside cut-outs would fall out; dropped from the part.`,
      });
    }
    if (plate.bevel > 0.05) {
      issues.push({
        partId: plate.parts[0]?.id ?? null,
        plateKey: plate.def.key,
        type: 'bevel',
        severity: 'info',
        message: `Avoided a ${plate.bevel.toFixed(2)} mm bevel: cavity cut straight at 90°.`,
      });
    }
  }

  for (const part of sliced.parts) {
    const s = part.shape;
    const bb = part.bbox;
    const w = bb.maxX - bb.minX;
    const h = bb.maxY - bb.minY;
    if (Math.min(w, h) < v.minPartSize) {
      issues.push({ partId: part.id, type: 'small', severity: 'warn', message: `Part is only ${Math.min(w, h).toFixed(1)} mm across (min ${v.minPartSize}).`, at: [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] });
    }
    if (Math.max(w, h) > sheetMax || Math.min(w, h) > sheetMin) {
      issues.push({ partId: part.id, type: 'sheet', severity: 'error', message: `Part (${w.toFixed(0)} × ${h.toFixed(0)}) does not fit the sheet.` });
    }
    if (!part.anchored) {
      const message = v.sliceMode === 'flat' ? 'Piece overhangs the layer below: nothing to glue it to.' : 'Piece does not reach the concrete: nothing holds it in place.';
      issues.push({ partId: part.id, type: 'unanchored', severity: 'error', message, at: [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] });
    }
    if (!part.labelAt) {
      issues.push({ partId: part.id, type: 'label', severity: 'info', message: 'No room to etch the part number.' });
    }
    // thin webs: morphological opening removes anything narrower than mf
    if (mf > 0) {
      for (const r of thinRegions(s, mf)) {
        const rb = shapeBBox(r);
        issues.push({
          partId: part.id,
          type: 'thin',
          severity: 'warn',
          message: `Material narrower than ${mf} mm.`,
          at: [(rb.minX + rb.maxX) / 2, (rb.minY + rb.maxY) / 2],
          region: r,
        });
      }
    }
    // gaps narrower than the kerf can't be cut: closing reveals them
    if (kerf > 0) {
      for (const r of gapRegions(s, kerf)) {
        const rb = shapeBBox(r);
        issues.push({ partId: part.id, type: 'gap', severity: 'error', message: `Gap narrower than the ${kerf} mm kerf.`, at: [(rb.minX + rb.maxX) / 2, (rb.minY + rb.maxY) / 2], region: r });
      }
    }
    // holes smaller than the sheet thickness pierce badly
    for (const hole of s[0]?.holes ?? []) {
      const a = Math.abs(signedArea(hole));
      const d = 2 * Math.sqrt(a / Math.PI);
      if (d < part.thickness) {
        const hb = shapeBBox([{ outer: hole, holes: [] }]);
        issues.push({ partId: part.id, type: 'hole', severity: 'warn', message: `Hole Ø${d.toFixed(1)} mm is smaller than the sheet thickness.`, at: [(hb.minX + hb.maxX) / 2, (hb.minY + hb.maxY) / 2] });
      }
    }
  }

  if (v.partSpacing < kerf) issues.push({ partId: null, type: 'gap', severity: 'error', message: `Nest part spacing (${v.partSpacing} mm) is below the kerf.` });
  if (v.pitch <= v.thickness && v.sliceMode !== 'radial' && v.sliceMode !== 'flat') issues.push({ partId: null, type: 'general', severity: 'error', message: 'Pitch is not larger than plate thickness: plates overlap.' });
  if (v.sliceMode === 'radial') {
    const n = v.radialCount;
    const minHub = v.thickness / 2 / Math.sin(Math.PI / n);
    if (v.radialHub < minHub) issues.push({ partId: null, type: 'collision', severity: 'error', message: `Radial plates touch at the hub: hub radius must be ≥ ${minHub.toFixed(1)} mm.` });
  }
  // chamfered base: plates must stay inside the footprint where they enter the concrete
  if (v.baseOn) {
    const ch = baseChamfers(v);
    if (ch.corner > 0 || ch.edge > 0) {
      for (const plate of sliced.plates) {
        if (!plate.parts.length) continue;
        const u0 = Math.min(...plate.parts.map((p) => p.bbox.minX));
        const u1 = Math.max(...plate.parts.map((p) => p.bbox.maxX));
        const P = plate.def.plane;
        const ends = [u0, u1].map((u) => ({ u, c: planClearance(v, P.origin[0] + P.u[0] * u, -(P.origin[2] + P.u[2] * u), ch.edge) }));
        const worst = ends[0].c < ends[1].c ? ends[0] : ends[1];
        if (worst.c < 0)
          issues.push({
            partId: plate.parts[0].id,
            plateKey: plate.def.key,
            type: 'general',
            severity: 'warn',
            message: `Plate runs ${(-worst.c).toFixed(1)} mm past the chamfered base edge.`,
            at: [worst.u, 0],
          });
      }
    }
  }

  // embedded support ring
  const sup = sliced.support;
  if (sup) {
    const cover = v.baseHeight + sup.tenonBottom;
    // 15 / 10 mm of cover on a full-size base, relaxing to MIN_FLOOR on small pieces
    const underMin = Math.max(MIN_FLOOR, Math.min(15, v.baseHeight / 4));
    const sideMin = Math.max(MIN_FLOOR, Math.min(10, Math.min(v.baseLength, v.baseWidth) / 10));
    if (cover <= 0) issues.push({ partId: null, type: 'general', severity: 'error', message: `Support ring and tenons reach ${(-cover).toFixed(1)} mm out of the bottom of the base.` });
    else if (cover < underMin) issues.push({ partId: null, type: 'general', severity: 'warn', message: `Only ${cover.toFixed(1)} mm of concrete under the support ring tenons (min ${underMin.toFixed(1)}).` });
    const side = planClearance(v, 0, 0, 0) - sup.outer;
    if (side < sideMin) issues.push({ partId: null, type: 'general', severity: side < 0 ? 'error' : 'warn', message: side < 0 ? 'Support ring is wider than the base.' : `Only ${side.toFixed(1)} mm of concrete beside the support ring.` });
    const missed = sliced.plates.filter((p) => p.parts.length && p.tenons === 0);
    if (missed.length)
      issues.push({ partId: missed[0].parts[0].id, plateKey: missed[0].def.key, type: 'general', severity: 'warn', message: `${missed.length} plate(s) don't cross the support ring, so it doesn't hold them. Widen the ring.` });
    if (v.embedMode === 'slot') issues.push({ partId: null, type: 'general', severity: 'warn', message: 'The support ring is cast in with the plates: set Concrete › Plate fixing to "Cast in".' });
  }
  issues.push(...moveChecks(v, sliced));
  // threaded rods and laser-cut spacers
  if (sliced.brace) {
    const byKey = new Map(sliced.parts.map((p) => [p.plateKey, p.id]));
    for (const b of sliced.brace.issues)
      issues.push({ partId: b.plateKey ? byKey.get(b.plateKey) ?? null : null, plateKey: b.plateKey, type: 'general', severity: b.severity, message: b.message, at: b.at });
  }
  if (sliced.stackRods) {
    for (const b of sliced.stackRods.issues)
      issues.push({ partId: b.partId ?? null, plateKey: b.plateKey, type: 'rod', severity: b.severity, message: b.message, at: b.at });
  }
  for (const w of sliced.warnings) issues.push({ partId: null, type: 'general', severity: 'warn', message: w });
  for (const ev of sliced.fragments ?? []) {
    issues.push({
      partId: ev.action === 'kept' ? ev.pieceId : ev.parentId ?? ev.plateId,
      plateKey: ev.plateKey,
      type: 'fragment',
      severity: 'info',
      message: formatFragment(ev),
    });
  }
  return issues;
}

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Grid points across a part's face (plate coords), at most ~1200 of them. */
function facePoints(p: Part): Vec2[] {
  const { minX, minY, maxX, maxY } = p.bbox;
  const step = Math.max(2, Math.sqrt(((maxX - minX) * (maxY - minY)) / 1200));
  const pts: Vec2[] = [];
  for (let y = minY + step / 2; y < maxY; y += step) for (let x = minX + step / 2; x < maxX; x += step) if (pointInShape([x, y], p.shape)) pts.push([x, y]);
  for (const [x, y] of p.shape[0].outer) pts.push([x, y]);
  return pts;
}

/** First point of `a` (through its thickness) that sits inside the solid of `b`, in a's plate coords. */
function overlapAt(a: Part, b: Part): Vec2 | null {
  const P = b.plane;
  const tol = b.thickness / 2 - 0.05;
  const rel = (w: V3): V3 => [w[0] - P.origin[0], w[1] - P.origin[1], w[2] - P.origin[2]];
  // quick reject: a's whole box on one side of b's slab
  const { minX, minY, maxX, maxY } = a.bbox;
  const ws: number[] = [];
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]])
    for (const w of [-a.thickness / 2, a.thickness / 2]) ws.push(dot3(rel(planeToWorld(a.plane, x, y, w)), P.normal));
  if (Math.min(...ws) > tol || Math.max(...ws) < -tol) return null;
  for (const [x, y] of facePoints(a)) {
    for (const w of [-a.thickness / 2 + 0.05, 0, a.thickness / 2 - 0.05]) {
      const r = rel(planeToWorld(a.plane, x, y, w));
      if (Math.abs(dot3(r, P.normal)) >= tol) continue;
      if (pointInShape([dot3(r, P.u), dot3(r, P.v)], b.shape)) return [x, y];
    }
  }
  return null;
}

/** Plates moved by hand: they must not run into each other, and must still sit in the base. */
function moveChecks(v: Values, sliced: SliceResult): Issue[] {
  const issues: Issue[] = [];
  const moved = sliced.plates.filter((p) => p.def.home && p.parts.length);
  const loose = sliced.parts.filter((p) => p.home);
  if (!moved.length && !loose.length) return issues;
  const all = sliced.parts.filter((p) => p.family !== 'S');
  const seen = new Set<string>();
  const clashes = (a: Part) => {
    for (const b of all) {
      if (b.plateKey === a.plateKey) continue;
      const pair = [a.id, b.id].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      const at = overlapAt(a, b);
      const back = at ? null : overlapAt(b, a);
      if (at || back)
        issues.push({
          partId: at ? a.id : b.id,
          plateKey: at ? a.plateKey : b.plateKey,
          type: 'collision',
          severity: 'error',
          message: `Moved part ${a.id} runs into ${b.id}.`,
          at: at ?? back ?? undefined,
        });
    }
  };
  loose.forEach(clashes);
  for (const plate of moved) {
    plate.parts.forEach(clashes);
    if (v.baseOn) {
      const top = v.baseHeight;
      const low = Math.min(...plate.parts.flatMap((p) => p.shape[0].outer.map(([x, y]) => planeToWorld(p.plane, x, y)[1])));
      const p0 = plate.parts[0];
      if (low > top - 0.5 && plate.parts.some((p) => p.anchored))
        issues.push({ partId: p0.id, plateKey: plate.def.key, type: 'unanchored', severity: 'error', message: `Moved plate ${p0.id} no longer reaches into the base (${(low - top).toFixed(1)} mm above it).` });
      else if (low < 0)
        issues.push({ partId: p0.id, plateKey: plate.def.key, type: 'general', severity: 'error', message: `Moved plate ${p0.id} pokes ${(-low).toFixed(1)} mm out of the bottom of the base.` });
    }
  }
  return issues;
}
