// Fabrication exports. Everything is regenerated from the model on demand:
// nothing is baked.
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { zipSync, strToU8 } from 'fflate';
import { installCardHtml } from './installCard';
import { buildPackHtml } from './buildPack';
import { fitArcs, type Seg } from './arcs';
import { DxfWriter, LAYERS } from './dxf';
import { bboxOf, offset, type Path, type Shape, type Vec2 } from './geom2d';
import type { Model } from './pipeline';
import type { Part } from './slicer';
import type { MouldPart } from './mould';
import type { Values } from './params';
import { extrudeOnPlane, extrudePlan, mergeGeometries } from './geometry3d';
import { cutListCsv, hardwareCsv } from './bom';
import { DEFAULT_RATES, estimateMix, priceText, withHardware, type PriceRates } from './price';
import { baseGeometry } from './base';
import { serialize, type Project } from './project';
import { strokeTextCentered } from './strokefont';
import type { UnfoldPiece } from './unfold';
import { materialOf } from './appearance';

export interface FittedContour {
  segs: Seg[];
  hole: boolean;
}

/** Kerf-compensate a shape then fit lines + arcs to every contour. */
export function fitShape(shape: Shape, v: Values): FittedContour[] {
  const comp = offset(shape, v.kerf / 2);
  const out: FittedContour[] = [];
  for (const ex of comp) {
    out.push({ segs: fitArcs(ex.outer, v.arcTolerance), hole: false });
    for (const h of ex.holes) out.push({ segs: fitArcs(h, v.arcTolerance), hole: true });
  }
  return out;
}

function emitContours(w: DxfWriter, contours: FittedContour[], v: Values, tf: (p: Vec2) => Vec2) {
  for (const c of contours) {
    const segs = c.segs.map((s) => mapSeg(s, tf));
    if (v.dxfMode === 'lines') w.linesAndArcs(LAYERS.CUT.name, segs);
    else w.polyline(LAYERS.CUT.name, segs, true);
  }
}

function mapSeg(s: Seg, tf: (p: Vec2) => Vec2): Seg {
  if (s.kind === 'line') return { kind: 'line', a: tf(s.a), b: tf(s.b) };
  const a = tf(s.a), b = tf(s.b), c = tf(s.c);
  // detect mirroring by checking orientation of a unit frame
  const o = tf([0, 0]), x = tf([1, 0]), y = tf([0, 1]);
  const det = (x[0] - o[0]) * (y[1] - o[1]) - (x[1] - o[1]) * (y[0] - o[0]);
  return { kind: 'arc', a, b, c, r: s.r, sweep: det < 0 ? -s.sweep : s.sweep };
}

const shiftTo = (minX: number, minY: number) => (p: Vec2): Vec2 => [p[0] - minX, p[1] - minY];

export function partDxf(part: Part, v: Values): string {
  const w = new DxfWriter([LAYERS.CUT, LAYERS.ETCH]);
  const bb = part.bbox;
  const tf = shiftTo(bb.minX - v.kerf, bb.minY - v.kerf);
  emitContours(w, fitShape(part.shape, v), v, tf);
  for (const p of [...part.etch, ...part.labelPaths]) w.path(LAYERS.ETCH.name, p.map(tf));
  return w.toString();
}

function rotPlace(bb: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number, rot: boolean) {
  return (p: Vec2): Vec2 => {
    const lx = p[0] - bb.minX;
    const ly = p[1] - bb.minY;
    if (!rot) return [x + lx, y + ly];
    // rotate 90° CCW: (lx, ly) -> (h - ly, lx)
    const h = bb.maxY - bb.minY;
    return [x + (h - ly), y + lx];
  };
}

export function sheetDxf(model: Model, sheetIndex: number): string {
  const v = model.v;
  const sheet = model.nested.sheets[sheetIndex];
  const byId = new Map(model.sliced.parts.map((p) => [p.id, p]));
  const w = new DxfWriter([LAYERS.CUT, LAYERS.ETCH, LAYERS.SHEET]);
  w.path(LAYERS.SHEET.name, [[0, 0], [v.sheetW, 0], [v.sheetW, v.sheetH], [0, v.sheetH]], true);
  for (const pl of sheet.placements) {
    const part = byId.get(pl.id);
    if (!part) continue;
    const tf = rotPlace(part.bbox, pl.x, pl.y, pl.rot);
    emitContours(w, fitShape(part.shape, v), v, tf);
    for (const p of [...part.etch, ...part.labelPaths]) w.path(LAYERS.ETCH.name, p.map(tf));
  }
  return w.toString();
}

export function mouldPartDxf(mp: MouldPart, v: Values): string {
  const w = new DxfWriter([LAYERS.CUT, LAYERS.ETCH]);
  const bb = bboxOf(mp.shape.map((e) => e.outer));
  const tf = shiftTo(bb.minX, bb.minY);
  // CNC router: no kerf offset here (the CAM tool-radius compensation handles it)
  for (const ex of mp.shape) {
    for (const path of [ex.outer, ...ex.holes]) {
      const segs = fitArcs(path, v.arcTolerance).map((s) => mapSeg(s, tf));
      if (v.dxfMode === 'lines') w.linesAndArcs(LAYERS.CUT.name, segs);
      else w.polyline(LAYERS.CUT.name, segs, true);
    }
  }
  const lab = mouldLabel(mp);
  if (lab) for (const p of lab) w.path(LAYERS.ETCH.name, p.map(tf));
  return w.toString();
}

function mouldLabel(mp: MouldPart): Path[] | null {
  // engrave the id on the wall, near the first outer edge
  const bb = bboxOf(mp.shape.map((e) => e.outer));
  const h = 8;
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = bb.minY + Math.min(20, (bb.maxY - bb.minY) / 2);
  return strokeTextCentered(mp.id, cx, cy, h);
}

export function shapeSvg(shapes: { shape: Shape; etch?: Path[] }[], pad = 5): string {
  const all = shapes.flatMap((s) => s.shape.map((e) => e.outer));
  const bb = bboxOf(all);
  const W = bb.maxX - bb.minX + pad * 2;
  const H = bb.maxY - bb.minY + pad * 2;
  const tx = (p: Vec2) => `${(p[0] - bb.minX + pad).toFixed(3)},${(bb.maxY - p[1] + pad).toFixed(3)}`;
  const d = (p: Path, close = true) => 'M' + p.map(tx).join('L') + (close ? 'Z' : '');
  const body = shapes
    .map(
      (s) =>
        `<path d="${s.shape.map((e) => [e.outer, ...e.holes].map((pp) => d(pp)).join('')).join('')}" fill="none" stroke="#e00" stroke-width="0.2" fill-rule="evenodd"/>` +
        (s.etch ?? []).map((pp) => `<path d="${d(pp, false)}" fill="none" stroke="#00e" stroke-width="0.2"/>`).join(''),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(2)}mm" height="${H.toFixed(2)}mm" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}">\n${body}\n</svg>\n`;
}

export function unfoldDxf(pieces: UnfoldPiece[], v: Values): string {
  const w = new DxfWriter([LAYERS.CUT, LAYERS.ETCH, LAYERS.BEND]);
  for (const pc of pieces) {
    for (const c of fitShape([{ outer: pc.outline, holes: [] }], v)) {
      if (v.dxfMode === 'lines') w.linesAndArcs(LAYERS.CUT.name, c.segs);
      else w.polyline(LAYERS.CUT.name, c.segs, true);
    }
    for (const b of pc.bends) w.path(LAYERS.BEND.name, b.line);
    const bb = bboxOf([pc.outline]);
    for (const p of strokeTextCentered(pc.id, (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, Math.min(8, (bb.maxY - bb.minY) / 6))) w.path(LAYERS.ETCH.name, p);
  }
  return w.toString();
}

const stlExporter = new STLExporter();

function geomToStl(geo: THREE.BufferGeometry): Uint8Array {
  const mesh = new THREE.Mesh(geo);
  const res = stlExporter.parse(mesh, { binary: true }) as unknown as DataView;
  return new Uint8Array(res.buffer, res.byteOffset, res.byteLength);
}

export function modelStl(model: Model): Uint8Array {
  const v = model.v;
  const geos: THREE.BufferGeometry[] = model.sliced.parts.map((p) => extrudeOnPlane(p.shape, p.thickness, p.plane));
  if (v.baseOn) {
    geos.push(baseGeometry(v));
  }
  if (model.insert) geos.push(model.insert.form.geometry.clone());
  return geomToStl(mergeGeometries(geos));
}

export function mouldStl(model: Model, body: 'base' | 'insert'): Uint8Array | null {
  const parts = model.moulds.parts.filter((p) => p.body === body);
  if (!parts.length) return null;
  return geomToStl(mergeGeometries(parts.map((p) => extrudePlan(p.shape, p.thickness, p.y0))));
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Laser sheet DXFs by file name. With mixed metals each metal gets its own folder, numbered from 1. */
export function sheetFiles(model: Model): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const mixed = new Set(model.nested.sheets.map((s) => s.material ?? '')).size > 1;
  const counts: Record<string, number> = {};
  model.nested.sheets.forEach((s, i) => {
    const dir = mixed && s.material ? `${safe(s.material)}/` : '';
    counts[dir] = (counts[dir] ?? 0) + 1;
    files[`${dir}sheet-${String(counts[dir]).padStart(2, '0')}.dxf`] = strToU8(sheetDxf(model, i));
  });
  return files;
}

/** One DXF per laser part. With mixed metals each metal gets its own folder. */
export function partFiles(model: Model, project?: Project): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const main = String(model.v.plateMaterial);
  const metal = (key: string) => materialOf(project?.appearance, key, main);
  const mixed = new Set(model.sliced.parts.map((p) => metal(p.plateKey))).size > 1;
  for (const p of model.sliced.parts) files[`${mixed ? `${safe(metal(p.plateKey))}/` : ''}${safe(p.id)}.dxf`] = strToU8(partDxf(p, model.v));
  return files;
}

/** `rates` are the price estimate's (the user's edited ones, when the UI has them). */
export function buildZip(model: Model, project: Project, rates: PriceRates = DEFAULT_RATES): Uint8Array {
  const v = model.v;
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(partFiles(model, project))) files[`laser/parts/${name}`] = data;
  for (const [name, data] of Object.entries(sheetFiles(model))) files[`laser/sheets/${name}`] = data;
  for (const mp of model.moulds.parts) {
    files[`mould/dxf/${safe(mp.id)}.dxf`] = strToU8(mouldPartDxf(mp, v));
    files[`mould/svg/${safe(mp.id)}.svg`] = strToU8(shapeSvg([{ shape: mp.shape }]));
  }
  const mb = mouldStl(model, 'base');
  if (mb) files['mould/base-mould.stl'] = mb;
  const mi = mouldStl(model, 'insert');
  if (mi) files['mould/insert-mould.stl'] = mi;
  if (model.unfolded.ok && model.unfolded.pieces.length) files['unfold/flat-pattern.dxf'] = strToU8(unfoldDxf([...model.unfolded.pieces, ...model.unfolded.caps], v));
  files['model.stl'] = modelStl(model);
  files['cutlist.csv'] = strToU8(cutListCsv(v, model.bom));
  if (model.bom.hardware.length) files['hardware.csv'] = strToU8(hardwareCsv(model.bom));
  files['pour-plan.txt'] = strToU8(pourPlanText(model));
  if (model.bom.partCount) {
    const estimate = withHardware(estimateMix(model.bom, v.thickness, rates), model.bom.hardware, rates);
    files['price-estimate.txt'] = strToU8(priceText(estimate, rates));
    files['price-estimate.json'] = strToU8(JSON.stringify(estimate, null, 2) + '\n');
  }
  if (model.shadow && project.shadow?.frames.length) files['shadow-install-card.html'] = strToU8(installCardHtml(project, v, model.shadow));
  files['build-pack.html'] = strToU8(buildPackHtml(project, model, { rates }));
  files['project.strata.json'] = strToU8(serialize(project));
  return zipSync(files, { level: 6 });
}

export function pourPlanText(model: Model): string {
  const lines = [`Strata pour plan — base ${model.v.baseLength} × ${model.v.baseWidth} × ${model.v.baseHeight} mm`, ''];
  model.pour.rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name}  ${r.color}  ${r.y0.toFixed(0)}–${r.y1.toFixed(0)} mm  (${r.height.toFixed(1)} mm)  ${r.volume.toFixed(1)} L  ${r.mass.toFixed(1)} kg`);
  });
  if (Math.abs(model.pour.mismatch) > 0.01) lines.push('', `WARNING: layers total ${model.pour.total.toFixed(1)} mm, base is ${model.v.baseHeight} mm.`);
  lines.push('', ...model.moulds.notes);
  return lines.join('\n') + '\n';
}

/** Open a self-contained HTML page (the build pack, an install card) in a new tab. */
export function openHtml(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function download(name: string, data: string | Uint8Array, mime = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
