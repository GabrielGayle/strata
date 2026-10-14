// Fabrication fit checks: everything that would make a part uncuttable or
// make it not fit once it's cut.
import { difference, offset, shapeArea, shapeBBox, signedArea, type Shape, type Vec2 } from './geom2d';
import type { Values } from './params';
import type { SliceResult } from './slicer';
import { baseChamfers, planClearance } from './base';

export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
  partId: string | null;
  plateKey?: string;
  type: 'thin' | 'gap' | 'small' | 'collision' | 'island' | 'unanchored' | 'hole' | 'sheet' | 'bevel' | 'label' | 'general';
  severity: Severity;
  message: string;
  at?: Vec2;
  region?: Shape;
}

function regions(s: Shape, minArea: number): Shape[] {
  return s.filter((e) => shapeArea([e]) > minArea).map((e) => [e]);
}

export function runChecks(v: Values, sliced: SliceResult): Issue[] {
  const issues: Issue[] = [];
  const mf = v.minFeature;
  const kerf = v.kerf;
  const sheetMax = Math.max(v.sheetW, v.sheetH);
  const sheetMin = Math.min(v.sheetW, v.sheetH);

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
      issues.push({ partId: part.id, type: 'unanchored', severity: 'error', message: 'Piece does not reach the concrete: nothing holds it in place.', at: [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] });
    }
    if (!part.labelAt) {
      issues.push({ partId: part.id, type: 'label', severity: 'info', message: 'No room to etch the part number.' });
    }
    // thin webs: morphological opening removes anything narrower than mf
    if (mf > 0) {
      const opened = offset(offset(s, -mf / 2, 'miter'), mf / 2, 'miter');
      const lost = difference(s, opened);
      for (const r of regions(lost, mf * mf * 0.6)) {
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
      const closed = offset(offset(s, kerf / 2, 'miter'), -kerf / 2, 'miter');
      const gained = difference(closed, s);
      for (const r of regions(gained, kerf * kerf * 4)) {
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
  if (v.pitch <= v.thickness && v.sliceMode !== 'radial') issues.push({ partId: null, type: 'general', severity: 'error', message: 'Pitch is not larger than plate thickness: plates overlap.' });
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
    if (cover <= 0) issues.push({ partId: null, type: 'general', severity: 'error', message: `Support ring and tenons reach ${(-cover).toFixed(1)} mm out of the bottom of the base.` });
    else if (cover < 15) issues.push({ partId: null, type: 'general', severity: 'warn', message: `Only ${cover.toFixed(1)} mm of concrete under the support ring tenons.` });
    const side = planClearance(v, 0, 0, 0) - sup.outer;
    if (side < 10) issues.push({ partId: null, type: 'general', severity: side < 0 ? 'error' : 'warn', message: side < 0 ? 'Support ring is wider than the base.' : `Only ${side.toFixed(1)} mm of concrete beside the support ring.` });
    const missed = sliced.plates.filter((p) => p.parts.length && p.tenons === 0);
    if (missed.length)
      issues.push({ partId: missed[0].parts[0].id, plateKey: missed[0].def.key, type: 'general', severity: 'warn', message: `${missed.length} plate(s) don't cross the support ring, so it doesn't hold them. Widen the ring.` });
    if (v.embedMode === 'slot') issues.push({ partId: null, type: 'general', severity: 'warn', message: 'The support ring is cast in with the plates: set Concrete › Plate fixing to "Cast in".' });
  }
  for (const w of sliced.warnings) issues.push({ partId: null, type: 'general', severity: 'warn', message: w });
  return issues;
}
