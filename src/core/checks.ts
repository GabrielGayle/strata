// Fabrication fit checks: everything that would make a part uncuttable or
// make it not fit once it's cut.
import { difference, offset, shapeArea, shapeBBox, signedArea, type Shape, type Vec2 } from './geom2d';
import type { Values } from './params';
import type { SliceResult } from './slicer';

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
  for (const w of sliced.warnings) issues.push({ partId: null, type: 'general', severity: 'warn', message: w });
  return issues;
}
