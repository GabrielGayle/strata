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
import type { Issue } from './checks';
import type { Model } from './pipeline';
import type { Part, PlateInfo } from './slicer';
import type { MouldPart } from './mould';
import type { Values } from './params';
import { extrudeOnPlane, extrudePlan, extrudeSunkenFrame, mergeGeometries } from './geometry3d';
import { cutListCsv, hardwareCsv } from './bom';
import { DEFAULT_RATES, estimateMix, priceText, withHardware, type PriceRates } from './price';
import { baseGeometry } from './base';
import { serialize, type Project } from './project';
import { strokeTextCentered } from './strokefont';
import { deserializeMapEngraveArt } from './mapOsmEngrave';
import { mapBackPlateEtchPaths } from './mapBackPlateEtch';
import { mapEngravePathsForPart, type MapEngravePlateContext } from './mapEngravePlate';
import type { UnfoldPiece } from './unfold';
import { materialOf } from './appearance';
import { packManifest } from './counts';
import {
  assertHtmlBuildPackIntegrity,
  assertZipBuildPackIntegrity,
  buildPlateManifest,
  BuildPackIntegrityError,
} from './buildPackIntegrity';

let exportBusy = false;
let exportCooldown = false;
let exportCooldownTimer: ReturnType<typeof setTimeout> | undefined;

/** Ignore a nested or double-clicked Export ZIP / Build pack while one is writing. */
export function withExportLock<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  if (exportBusy || exportCooldown) return { ok: false };
  exportBusy = true;
  try {
    return { ok: true, value: fn() };
  } finally {
    exportBusy = false;
    exportCooldown = true;
    clearTimeout(exportCooldownTimer);
    exportCooldownTimer = setTimeout(() => {
      exportCooldown = false;
    }, 400);
  }
}

export class FitCheckExportError extends Error {
  readonly errors: Issue[];
  constructor(errors: Issue[]) {
    const n = errors.length;
    const head = errors
      .slice(0, 3)
      .map((e) => (e.partId ? `${e.partId}: ${e.message}` : e.message))
      .join(' ');
    super(`Export refused: ${n} fit error${n === 1 ? '' : 's'} remain${n === 1 ? 's' : ''}.${head ? ` ${head}` : ''}`);
    this.name = 'FitCheckExportError';
    this.errors = errors;
  }
}

export function fitExportErrors(model: Model): Issue[] {
  return model.issues.filter((i) => i.severity === 'error');
}

/** Fabrication ZIP / build pack / plate DXF bundles must not ship while fit errors remain. */
export function assertExportable(model: Model): void {
  const errors = fitExportErrors(model);
  if (errors.length) throw new FitCheckExportError(errors);
}

export function exportFailureMessage(e: unknown): string {
  if (e instanceof FitCheckExportError) return e.message;
  if (e instanceof BuildPackIntegrityError) return `Fabrication zip integrity: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

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

/** A closed contour that is a circle within `tol` (round holes → CIRCLE). */
export function segsAsCircle(segs: Seg[], tol: number): { cx: number; cy: number; r: number } | null {
  if (segs.length < 2) return null;
  const arcs = segs.filter((s): s is Extract<Seg, { kind: 'arc' }> => s.kind === 'arc');
  const lines = segs.filter((s): s is Extract<Seg, { kind: 'line' }> => s.kind === 'line');
  if (arcs.length >= 2) {
    const a0 = arcs[0];
    const allow = Math.max(tol, a0.r * 0.02);
    let sweep = 0;
    for (const s of arcs) {
      if (Math.abs(s.r - a0.r) > allow) return null;
      if (Math.hypot(s.c[0] - a0.c[0], s.c[1] - a0.c[1]) > allow) return null;
      sweep += s.sweep;
    }
    // Two 180° arcs plus a tiny closing chord is still a circle; a rounded
    // rect has corner arcs on different centres and fails above.
    if (Math.abs(Math.abs(sweep) - Math.PI * 2) > 0.6) return null;
    for (const s of lines) {
      const d0 = Math.hypot(s.a[0] - a0.c[0], s.a[1] - a0.c[1]);
      const d1 = Math.hypot(s.b[0] - a0.c[0], s.b[1] - a0.c[1]);
      if (Math.abs(d0 - a0.r) > allow || Math.abs(d1 - a0.r) > allow) return null;
      if (Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > a0.r * 0.45) return null;
    }
    return { cx: a0.c[0], cy: a0.c[1], r: a0.r };
  }
  // Tessellated circle (no arcs): many short chords, including midpoints on the rim.
  // Four rectangle corners lie on a circle — reject those (need ≥ 8 chords).
  if (lines.length !== segs.length || segs.length < 8) return null;
  const pts = segs.map((s) => s.a);
  pts.push(segs[segs.length - 1].b);
  let sx = 0, sy = 0;
  for (const p of pts) {
    sx += p[0];
    sy += p[1];
  }
  const cx = sx / pts.length, cy = sy / pts.length;
  const rs = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  const r = rs.reduce((a, b) => a + b, 0) / rs.length;
  if (r < 0.2) return null;
  const allow = Math.max(tol, r * 0.02);
  if (rs.some((x) => Math.abs(x - r) > allow)) return null;
  for (const s of lines) {
    const mx = (s.a[0] + s.b[0]) / 2;
    const my = (s.a[1] + s.b[1]) / 2;
    if (Math.abs(Math.hypot(mx - cx, my - cy) - r) > allow) return null;
  }
  return { cx, cy, r };
}

function placeCircle(circ: { cx: number; cy: number; r: number }, tf: (p: Vec2) => Vec2) {
  const c = tf([circ.cx, circ.cy]);
  const q = tf([circ.cx + circ.r, circ.cy]);
  return { cx: c[0], cy: c[1], r: Math.hypot(q[0] - c[0], q[1] - c[1]) };
}

function emitContours(w: DxfWriter, contours: FittedContour[], v: Values, tf: (p: Vec2) => Vec2) {
  const tol = Math.max(0.02, v.arcTolerance * 2);
  for (const c of contours) {
    if (c.hole) {
      const local = segsAsCircle(c.segs, tol);
      if (local) {
        const circ = placeCircle(local, tf);
        w.circle(LAYERS.CUT.name, circ.cx, circ.cy, circ.r);
        continue;
      }
    }
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

export { BuildPackIntegrityError } from './buildPackIntegrity';

export function partDxf(part: Part, v: Values, mapEngrave: Path[] = [], extraEtch: Path[] = []): string {
  const w = new DxfWriter([LAYERS.CUT, LAYERS.ETCH, LAYERS.ENGRAVE]);
  const bb = part.bbox;
  const tf = shiftTo(bb.minX - v.kerf, bb.minY - v.kerf);
  emitContours(w, fitShape(part.shape, v), v, tf);
  for (const p of [...part.etch, ...part.labelPaths, ...extraEtch]) w.path(LAYERS.ETCH.name, p.map(tf));
  for (const p of mapEngrave) w.path(LAYERS.ENGRAVE.name, p.map(tf));
  return w.toString();
}

function bottomPlateIndex(model: Model): number {
  const idxs = model.sliced.parts.filter((q) => q.family === 'P').map((q) => q.index);
  return idxs.length ? Math.min(...idxs) : -1;
}

function mapBackEtchForPart(part: Part, project?: Project, model?: Model): Path[] {
  const map = project?.images.top?.map;
  if (!map || !model) return [];
  if (part.family !== 'P' || part.index !== bottomPlateIndex(model)) return [];
  return mapBackPlateEtchPaths(part, map);
}

function mapEngraveForPart(part: Part, project?: Project, model?: Model): Path[] {
  const map = project?.images.top?.map;
  if (!map?.engraveArt || !map.engrave.enabled) return [];
  if (model) {
    const topIdx = Math.max(...model.sliced.parts.filter((q) => q.family === 'P').map((q) => q.index), -1);
    if (part.family !== 'P' || part.index !== topIdx) return [];
  }
  const art = deserializeMapEngraveArt(map.engraveArt);
  const ctx: MapEngravePlateContext = {
    faceW: part.bbox.maxX - part.bbox.minX,
    faceH: part.bbox.maxY - part.bbox.minY,
    presetId: map.engrave.preset,
    title: map.engrave.features.includes('title') ? map.title : undefined,
  };
  return mapEngravePathsForPart(part, art, ctx);
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

function sheetParts(model: Model, sheetIndex: number) {
  const sheet = model.nested.sheets[sheetIndex];
  const byId = new Map(model.sliced.parts.map((p) => [p.id, p]));
  return sheet.placements.map((pl) => {
    const part = byId.get(pl.id);
    return part ? { pl, part, tf: rotPlace(part.bbox, pl.x, pl.y, pl.rot) } : null;
  }).filter((x): x is { pl: (typeof sheet.placements)[number]; part: Part; tf: (p: Vec2) => Vec2 } => !!x);
}

/** Nested sheet, CUT only: part outlines and holes. No sheet border, no etch. Send this to the laser. */
export function sheetCutDxf(model: Model, sheetIndex: number): string {
  const v = model.v;
  const w = new DxfWriter([LAYERS.CUT]);
  for (const { part, tf } of sheetParts(model, sheetIndex)) emitContours(w, fitShape(part.shape, v), v, tf);
  return w.toString();
}

/** Nested sheet etch/engrave sidecar (part numbers and artwork). Null when the sheet has none. */
export function sheetEtchDxf(model: Model, sheetIndex: number): string | null {
  const w = new DxfWriter([LAYERS.ETCH, LAYERS.ENGRAVE]);
  let n = 0;
  for (const { part, tf } of sheetParts(model, sheetIndex)) {
    for (const p of [...part.etch, ...part.labelPaths]) {
      w.path(LAYERS.ETCH.name, p.map(tf));
      n++;
    }
  }
  return n ? w.toString() : null;
}

/** Cut-only nested sheet (same as `sheetCutDxf`). */
export function sheetDxf(model: Model, sheetIndex: number): string {
  return sheetCutDxf(model, sheetIndex);
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
  if (model.sunkenFrame) geos.push(extrudeSunkenFrame(model.sunkenFrame));
  else if (v.baseOn) geos.push(baseGeometry(v));
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
    const nn = String(counts[dir]).padStart(2, '0');
    files[`${dir}sheet-${nn}-cut.dxf`] = strToU8(sheetCutDxf(model, i));
    const etch = sheetEtchDxf(model, i);
    if (etch) files[`${dir}sheet-${nn}-etch.dxf`] = strToU8(etch);
  });
  return files;
}

export function packReadme(model: Model): string {
  const v = model.v;
  const lines = [
    'Strata fabrication pack',
    '=======================',
    '',
    'laser/parts/*.dxf',
    '  One file per laser-cut part (outlines, holes, and etch). Round holes are CIRCLE;',
    '  other outlines are LWPOLYLINE. Layers: CUT (cut this), ETCH / ENGRAVE (optional).',
    '',
    'laser/sheets/sheet-NN-cut.dxf',
    '  Nested sheet, CUT ONLY. Closed LWPOLYLINE outlines (CIRCLE for round holes) on',
    '  the CUT layer — the same structure Commissary quotes: no 1250×2500 sheet border',
    '  and no etch. That rectangle is not a cut; quoting it as one inflates the price.',
    '',
    'laser/sheets/sheet-NN-etch.dxf',
    '  Optional sidecar: part numbers and artwork on ETCH / ENGRAVE. Omit this file',
    '  if you do not want etching. Never merge it into the cut file for a cut quote.',
    '',
    `Sheets are ${v.sheetW} × ${v.sheetH} mm. Nested parts use ${v.partSpacing} mm spacing.`,
    `Plate thickness ${v.thickness} mm. Kerf compensation ${v.kerf} mm (outlines offset by half).`,
    '',
    `This pack has ${model.bom.plateCount} plates and ${model.bom.partCount} laser-cut parts.`,
    'Counts in header, status, schedule, laser/parts, and manifest.json must match those two numbers.',
  ];
  const dropped = (model.sliced.fragments ?? []).filter((e) => e.action === 'dropped' || e.action === 'merged');
  if (dropped.length) {
    lines.push('', 'Fragments handled:');
    for (const ev of dropped) lines.push(`  - ${ev.action} ${ev.pieceId} (${ev.w.toFixed(2)} × ${ev.h.toFixed(2)} mm)`);
  }
  return lines.join('\n') + '\n';
}

/** One DXF per laser part. With mixed metals each metal gets its own folder. */
export function partFiles(model: Model, project?: Project): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const main = String(model.v.plateMaterial);
  const metal = (key: string) => materialOf(project?.appearance, key, main);
  const mixed = new Set(model.sliced.parts.map((p) => metal(p.plateKey))).size > 1;
  for (const p of model.sliced.parts) {
    const engrave = mapEngraveForPart(p, project, model);
    const backEtch = mapBackEtchForPart(p, project, model);
    const rel = `${mixed ? `${safe(metal(p.plateKey))}/` : ''}${safe(p.id)}.dxf`;
    if (files[rel]) {
      throw new BuildPackIntegrityError(`Duplicate laser part path laser/parts/${rel} (part ${p.id})`);
    }
    files[rel] = strToU8(partDxf(p, model.v, engrave, backEtch));
  }
  return files;
}

/** Combined DXF for every piece on one plate (same plane). */
export function plateDxf(plate: PlateInfo, model: Model, project?: Project): string {
  const v = model.v;
  const w = new DxfWriter([LAYERS.CUT, LAYERS.ETCH, LAYERS.ENGRAVE]);
  for (const p of plate.parts) {
    const engrave = mapEngraveForPart(p, project, model);
    const backEtch = mapBackEtchForPart(p, project, model);
    const bb = p.bbox;
    const tf = shiftTo(bb.minX - v.kerf, bb.minY - v.kerf);
    emitContours(w, fitShape(p.shape, v), v, tf);
    for (const path of [...p.etch, ...p.labelPaths, ...backEtch]) w.path(LAYERS.ETCH.name, path.map(tf));
    for (const path of engrave) w.path(LAYERS.ENGRAVE.name, path.map(tf));
  }
  return w.toString();
}

/** Combined SVG for every piece on one plate. */
export function plateSvg(plate: PlateInfo): string {
  if (!plate.parts.length) return emptyPlateSvg(plate.def.key);
  return shapeSvg(plate.parts.map((p) => ({ shape: p.shape, etch: [...p.etch, ...p.labelPaths] })));
}

/** Placeholder geometry so an empty layer still has a pack file (NOTE layer / outline). */
export function emptyPlateDxf(key: string): string {
  const w = new DxfWriter([LAYERS.NOTE]);
  const wdt = Math.min(40, 12 + key.length);
  w.path(LAYERS.NOTE.name, [[0, 0], [wdt, 0], [wdt, 8], [0, 8]], true);
  return w.toString();
}

export function emptyPlateSvg(key: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="16mm" viewBox="0 0 40 16"><path d="M1,1h38v14h-38Z" fill="none" stroke="#888" stroke-width="0.4"/><text x="20" y="10" text-anchor="middle" font-size="4">empty ${key.replace(/[<>&"]/g, '')}</text></svg>\n`;
}

function plateArtifactFiles(model: Model, project: Project): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const manifest = buildPlateManifest(model, project);
  const byKey = new Map(model.sliced.plates.map((pl) => [pl.def.key, pl]));
  for (const row of manifest.plates) {
    const pl = byKey.get(row.key);
    if (!pl) continue;
    files[row.dxf] = strToU8(pl.parts.length ? plateDxf(pl, model, project) : emptyPlateDxf(row.key));
    files[row.svg] = strToU8(pl.parts.length ? plateSvg(pl) : emptyPlateSvg(row.key));
  }
  return files;
}

/** Printable build pack HTML with integrity checks (use this instead of `buildPackHtml` directly). */
export function buildPackHtmlChecked(project: Project, model: Model, opts: import('./buildPack').BuildPackOptions = {}): string {
  assertExportable(model);
  const html = buildPackHtml(project, model, opts);
  assertHtmlBuildPackIntegrity(project, model, html);
  return html;
}

/** `rates` are the price estimate's (the user's edited ones, when the UI has them). */
export function buildZip(model: Model, project: Project, rates: PriceRates = DEFAULT_RATES): Uint8Array {
  assertExportable(model);
  const v = model.v;
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(partFiles(model, project))) files[`laser/parts/${name}`] = data;
  for (const [name, data] of Object.entries(plateArtifactFiles(model, project))) files[name] = data;
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
  files['README.txt'] = strToU8(packReadme(model));
  files['build-pack.html'] = strToU8(buildPackHtmlChecked(project, model, { rates }));
  files['manifest.json'] = strToU8(JSON.stringify({ ...packManifest(model), ...buildPlateManifest(model, project) }, null, 2) + '\n');
  const archetype = project.images.top?.map?.archetypeCard;
  if (archetype && typeof archetype === 'object') {
    files['map/archetype-card.json'] = strToU8(JSON.stringify(archetype, null, 2) + '\n');
  }
  files['project.strata.json'] = strToU8(serialize(project));
  assertZipBuildPackIntegrity(model, project, files);
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
