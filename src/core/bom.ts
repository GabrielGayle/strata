// Cut list and bill of materials.
import { baseVolumeBetween } from './base';
import type { Values } from './params';
import type { SliceResult } from './slicer';
import type { NestResult } from './nest';
import type { MouldResult, PourPlanRow } from './mould';
import { embedOf } from './slicer';

export const DENSITY: Record<string, number> = { steel: 7850, aluminium: 2700, corten: 7850 };
export const MATERIAL_NAME: Record<string, string> = { steel: 'Mild steel', aluminium: 'Aluminium', corten: 'Corten steel' };

export interface CutRow {
  id: string;
  w: number;
  h: number;
  area: number; // mm²
  cut: number; // mm of cut path
  pierces: number;
  mass: number; // kg
}

export interface Bom {
  rows: CutRow[];
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
}

export function buildBom(
  v: Values,
  sliced: SliceResult,
  nested: NestResult,
  moulds: MouldResult,
  mouldNest: NestResult,
  insertVolume: number, // mm³
  pour: PourPlanRow[],
): Bom {
  const rho = DENSITY[v.plateMaterial] ?? 7850;
  const rows: CutRow[] = sliced.parts.map((p) => {
    const ex = p.shape[0];
    const pierces = 1 + ex.holes.length;
    return {
      id: p.id,
      w: p.bbox.maxX - p.bbox.minX,
      h: p.bbox.maxY - p.bbox.minY,
      area: p.area,
      cut: p.perimeter,
      pierces,
      mass: (p.area * p.thickness * 1e-9) * rho,
    };
  });
  const plateArea = rows.reduce((a, r) => a + r.area, 0) / 1e6;
  const plateMass = rows.reduce((a, r) => a + r.mass, 0);
  const embedVol = sliced.parts.reduce((a, p) => {
    if (p.family === 'S') return a + p.area * p.thickness; // the support ring is all inside the concrete
    const e = embedOf(v);
    if (e <= 0) return a;
    return a + (p.bbox.maxX - p.bbox.minX) * Math.min(e, Math.max(0, -p.bbox.minY)) * p.thickness;
  }, 0);
  const baseVol = v.baseOn ? Math.max(0, baseVolumeBetween(v, 0, v.baseHeight) - embedVol) : 0;
  const insVol = v.insShape !== 'none' && v.insMaterial === 'concrete' ? insertVolume : 0;
  const plyArea = moulds.parts.reduce((a, p) => a + p.area, 0) / 1e6;
  return {
    rows,
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
  };
}

export function cutListCsv(v: Values, bom: Bom): string {
  const lines = ['part,width_mm,height_mm,area_mm2,cut_length_mm,pierces,mass_kg,material,thickness_mm'];
  for (const r of bom.rows)
    lines.push([r.id, r.w.toFixed(2), r.h.toFixed(2), r.area.toFixed(1), r.cut.toFixed(1), r.pierces, r.mass.toFixed(3), MATERIAL_NAME[v.plateMaterial], v.thickness].join(','));
  return lines.join('\n') + '\n';
}
