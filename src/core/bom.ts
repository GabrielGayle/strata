// Cut list and bill of materials.
import { baseVolumeBetween } from './base';
import type { Values } from './params';
import type { SliceResult } from './slicer';
import type { NestResult } from './nest';
import type { MouldResult, PourPlanRow } from './mould';
import { embedOf } from './slicer';
import type { HardwareRow } from './brace';
import { bucketOf, type Appearance } from './appearance';
import { pathLength } from './geom2d';

export const DENSITY: Record<string, number> = { steel: 7850, aluminium: 2700, corten: 7850 };
export const MATERIAL_NAME: Record<string, string> = { steel: 'Mild steel', aluminium: 'Aluminium', corten: 'Corten steel' };

export interface CutRow {
  id: string;
  w: number;
  h: number;
  area: number; // mm²
  cut: number; // mm of cut path (the outline, not etch)
  /** mm of ETCH-layer lines (artwork and part numbers). Chop Chop prices these as cut. */
  etch: number;
  pierces: number;
  mass: number; // kg
  /** Metal the part is cut from. */
  material: string;
  /** Appearance bucket name, when the part is in one. */
  bucket?: string;
}

/** Plates cut from one metal: a laser shop runs each as its own job. */
export interface MaterialGroup {
  material: string;
  rows: CutRow[];
  partCount: number;
  plateMass: number; // kg
  cutLength: number; // m
  pierces: number;
}

export interface Bom {
  rows: CutRow[];
  /** One entry per metal, main material first. */
  byMaterial: MaterialGroup[];
  plateCount: number;
  partCount: number;
  plateArea: number; // m²
  plateMass: number; // kg
  cutLength: number; // m
  pierces: number;
  sheets: number;
  utilisation: number;
  concreteBase: number; // litres
  concreteInsert: number; // litres
  concreteMass: number; // kg
  plyParts: number;
  plySheets: number;
  plyArea: number; // m²
  dowels: number;
  bolts: number;
  pour: PourPlanRow[];
  /** Bought-in bracing hardware: threaded rods, nuts, washers. */
  hardware: HardwareRow[];
}

export function buildBom(
  v: Values,
  sliced: SliceResult,
  nested: NestResult,
  moulds: MouldResult,
  mouldNest: NestResult,
  insertVolume: number, // mm³
  pour: PourPlanRow[],
  appearance?: Appearance,
): Bom {
  const rows: CutRow[] = sliced.parts.map((p) => {
    const ex = p.shape[0];
    const pierces = 1 + ex.holes.length;
    const bucket = bucketOf(appearance, p.plateKey);
    const material = bucket?.material ?? v.plateMaterial;
    const rho = DENSITY[material] ?? 7850;
    return {
      id: p.id,
      w: p.bbox.maxX - p.bbox.minX,
      h: p.bbox.maxY - p.bbox.minY,
      area: p.area,
      cut: p.perimeter,
      etch: [...p.etch, ...p.labelPaths].reduce((a, path) => a + pathLength(path, false), 0),
      pierces,
      mass: (p.area * p.thickness * 1e-9) * rho,
      material,
      ...(bucket ? { bucket: bucket.name } : {}),
    };
  });
  const plateArea = rows.reduce((a, r) => a + r.area, 0) / 1e6;
  const plateMass = rows.reduce((a, r) => a + r.mass, 0);
  const embedVol = sliced.parts.reduce((a, p) => {
    if (p.family === 'S' || p.family === 'C') return a + p.area * p.thickness; // the support ring and cross pieces are all inside the concrete
    if (p.family === 'T') return a; // the spacing template comes off after the cure
    const e = embedOf(v);
    if (e <= 0) return a;
    return a + (p.bbox.maxX - p.bbox.minX) * Math.min(e, Math.max(0, -p.bbox.minY)) * p.thickness;
  }, 0);
  const baseVol = v.baseOn ? Math.max(0, baseVolumeBetween(v, 0, v.baseHeight) - embedVol) : 0;
  const insVol = v.insShape !== 'none' && v.insMaterial === 'concrete' ? insertVolume : 0;
  const plyArea = moulds.parts.reduce((a, p) => a + p.area, 0) / 1e6;
  return {
    rows,
    byMaterial: groupByMaterial(rows, v.plateMaterial),
    plateCount: sliced.plates.filter((p) => p.parts.length).length,
    partCount: sliced.parts.length,
    plateArea,
    plateMass,
    cutLength: rows.reduce((a, r) => a + r.cut, 0) / 1000,
    pierces: rows.reduce((a, r) => a + r.pierces, 0),
    sheets: nested.sheets.length,
    utilisation: nested.utilisation,
    concreteBase: baseVol / 1e6,
    concreteInsert: insVol / 1e6,
    concreteMass: ((baseVol + insVol) / 1e9) * 2400,
    plyParts: moulds.parts.length,
    plySheets: mouldNest.sheets.length,
    plyArea,
    dowels: moulds.dowels,
    bolts: moulds.bolts,
    pour,
    hardware: sliced.brace?.hardware ?? [],
  };
}

export function groupByMaterial(rows: CutRow[], main: string): MaterialGroup[] {
  const groups = new Map<string, CutRow[]>([[main, []]]);
  for (const r of rows) {
    if (!groups.has(r.material)) groups.set(r.material, []);
    groups.get(r.material)!.push(r);
  }
  return [...groups]
    .filter(([m, rs]) => rs.length || m === main)
    .map(([material, rs]) => ({
      material,
      rows: rs,
      partCount: rs.length,
      plateMass: rs.reduce((a, r) => a + r.mass, 0),
      cutLength: rs.reduce((a, r) => a + r.cut, 0) / 1000,
      pierces: rs.reduce((a, r) => a + r.pierces, 0),
    }));
}

export function hardwareCsv(bom: Bom): string {
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['item,spec,qty,note'];
  for (const r of bom.hardware) lines.push([r.item, r.spec, String(r.qty), r.note ?? ''].map(q).join(','));
  return lines.join('\n') + '\n';
}

export function cutListCsv(v: Values, bom: Bom): string {
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['part,width_mm,height_mm,area_mm2,cut_length_mm,pierces,mass_kg,material,thickness_mm,bucket'];
  for (const r of bom.rows)
    lines.push([r.id, r.w.toFixed(2), r.h.toFixed(2), r.area.toFixed(1), r.cut.toFixed(1), r.pierces, r.mass.toFixed(3), MATERIAL_NAME[r.material] ?? r.material, v.thickness, q(r.bucket ?? '')].join(','));
  return lines.join('\n') + '\n';
}
