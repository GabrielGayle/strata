// Build-pack integrity: every plate in the model must appear in the fabrication
// zip (manifest + per-plate files + laser parts) and in the printable HTML.
import { bboxOf, type BBox } from './geom2d';
import { materialOf } from './appearance';
import type { Model } from './pipeline';
import type { Project } from './project';
import type { Part } from './slicer';

export class BuildPackIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildPackIntegrityError';
  }
}

export const safeZipName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Pick a zip path that does not collide with one already claimed. */
export function uniqueZipPath(claimed: Set<string>, desired: string): string {
  if (!claimed.has(desired)) {
    claimed.add(desired);
    return desired;
  }
  const slash = desired.lastIndexOf('/');
  const base = slash >= 0 ? desired.slice(slash + 1) : desired;
  const dir = slash >= 0 ? desired.slice(0, slash + 1) : '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  let next = `${dir}${stem}-${n}${ext}`;
  while (claimed.has(next)) {
    n++;
    next = `${dir}${stem}-${n}${ext}`;
  }
  claimed.add(next);
  return next;
}

export interface PlateManifestEntry {
  index: number;
  key: string;
  family: string;
  name: string;
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
  /** Stack layer index (flat) or plate index within family. */
  layer: number;
  /** True when the layer has no cuttable geometry (zero-area / fully stamped away). Still in the pack. */
  empty: boolean;
  dxf: string;
  svg: string;
  partIds: string[];
  partFiles: string[];
}

export interface BuildPackManifest {
  version: 1;
  plateCount: number;
  plates: PlateManifestEntry[];
}

function mixedMetals(model: Model, project?: Project): boolean {
  const main = String(model.v.plateMaterial);
  return new Set(model.sliced.parts.map((p) => materialOf(project?.appearance, p.plateKey, main))).size > 1;
}

/** Relative zip path for a laser-cut part DXF. */
export function laserPartPath(model: Model, project: Project | undefined, part: Part): string {
  const main = String(model.v.plateMaterial);
  const metal = materialOf(project?.appearance, part.plateKey, main);
  const mixed = mixedMetals(model, project);
  return `laser/parts/${mixed ? `${safeZipName(metal)}/` : ''}${safeZipName(part.id)}.dxf`;
}

function plateBBox(parts: Part[]): BBox {
  const outers = parts.flatMap((p) => p.shape.map((e) => e.outer));
  return bboxOf(outers);
}

function plateName(parts: Part[]): string {
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].id;
  const stem = parts[0].id.slice(0, -1);
  return parts.every((p) => p.id.slice(0, -1) === stem) ? `${stem}${parts.map((p) => p.id.slice(-1)).join(',')}` : parts.map((p) => p.id).join(', ');
}

/** One row per `sliced.plates` entry, including empty / zero-area layers. */
export function buildPlateManifest(model: Model, project: Project): BuildPackManifest {
  const claimed = new Set<string>();
  const plates: PlateManifestEntry[] = model.sliced.plates.map((pl) => {
    const bb = pl.parts.length ? plateBBox(pl.parts) : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const key = pl.def.key;
    return {
      index: pl.def.index,
      key,
      family: pl.def.family,
      name: plateName(pl.parts) || key,
      widthMm: bb.maxX - bb.minX,
      heightMm: bb.maxY - bb.minY,
      thicknessMm: pl.parts[0]?.thickness ?? model.v.thickness,
      layer: pl.def.index,
      empty: pl.parts.length === 0,
      dxf: uniqueZipPath(claimed, `plates/${safeZipName(key)}.dxf`),
      svg: uniqueZipPath(claimed, `plates/${safeZipName(key)}.svg`),
      partIds: pl.parts.map((p) => p.id),
      partFiles: pl.parts.map((p) => laserPartPath(model, project, p)),
    };
  });
  return { version: 1, plateCount: plates.length, plates };
}

/** In-app plate count: every slice slot, including empty layers. */
export function inAppPlateCount(model: Model): number {
  return model.sliced.plates.length;
}

export function dxfHasEntities(text: string): boolean {
  return text.includes('ENTITIES') && /0\s+(LINE|POLYLINE|LWPOLYLINE|ARC|CIRCLE)\b/i.test(text);
}

export function svgHasPaths(text: string): boolean {
  return /<path\s/i.test(text) && /d="/i.test(text);
}

function assertUniquePartPaths(model: Model, project: Project): void {
  const seen = new Map<string, string>();
  for (const p of model.sliced.parts) {
    const path = laserPartPath(model, project, p);
    const prev = seen.get(path);
    if (prev && prev !== p.id) {
      throw new BuildPackIntegrityError(
        `Laser part path collision: ${path} would be shared by ${prev} and ${p.id} after filename sanitisation`,
      );
    }
    seen.set(path, p.id);
  }
}

/** Verify zip contents against the model and manifest. */
export function assertZipBuildPackIntegrity(model: Model, project: Project, files: Record<string, Uint8Array>): BuildPackManifest {
  assertUniquePartPaths(model, project);
  const manifest = buildPlateManifest(model, project);
  const dec = new TextDecoder();

  if (manifest.plateCount !== model.sliced.plates.length) {
    throw new BuildPackIntegrityError(`Manifest plate count ${manifest.plateCount} ≠ model plate count ${model.sliced.plates.length}`);
  }

  for (const row of manifest.plates) {
    const pl = model.sliced.plates.find((p) => p.def.key === row.key);
    if (!pl) throw new BuildPackIntegrityError(`Manifest lists unknown plate ${row.key}`);
    if (row.empty !== (pl.parts.length === 0)) {
      throw new BuildPackIntegrityError(`Plate ${row.key} empty flag ${row.empty} ≠ model (${pl.parts.length} parts)`);
    }
    for (const rel of [row.dxf, row.svg]) {
      const data = files[rel];
      if (!data?.length) throw new BuildPackIntegrityError(`Missing or empty build-pack file ${rel} for plate ${row.key}`);
      const text = dec.decode(data);
      if (rel.endsWith('.dxf') && !dxfHasEntities(text)) {
        throw new BuildPackIntegrityError(`Plate DXF has no cut entities: ${rel}`);
      }
      if (rel.endsWith('.svg') && !svgHasPaths(text)) {
        throw new BuildPackIntegrityError(`Plate SVG has no paths: ${rel}`);
      }
    }
    for (const partFile of row.partFiles) {
      const data = files[partFile];
      if (!data?.length) throw new BuildPackIntegrityError(`Missing laser part file ${partFile} for plate ${row.key}`);
      if (!dxfHasEntities(dec.decode(data))) {
        throw new BuildPackIntegrityError(`Laser part DXF has no entities: ${partFile}`);
      }
    }
    const names = new Set(Object.keys(files).map((n) => n.split('/').pop()));
    for (const id of row.partIds) {
      const fn = `${safeZipName(id)}.dxf`;
      if (!names.has(fn)) throw new BuildPackIntegrityError(`Zip has no unique entry for part ${id} (${fn})`);
    }
  }

  const manifestBytes = files['manifest.json'];
  if (!manifestBytes?.length) throw new BuildPackIntegrityError('manifest.json missing from fabrication zip');
  const onDisk = JSON.parse(dec.decode(manifestBytes)) as BuildPackManifest;
  if (onDisk.plateCount !== manifest.plateCount) {
    throw new BuildPackIntegrityError(`manifest.json plateCount ${onDisk.plateCount} ≠ model ${manifest.plateCount}`);
  }
  const plateDxfCount = Object.keys(files).filter((n) => n.startsWith('plates/') && n.endsWith('.dxf')).length;
  if (plateDxfCount !== model.sliced.plates.length) {
    throw new BuildPackIntegrityError(`Zip has ${plateDxfCount} plates/*.dxf files, model has ${model.sliced.plates.length} plates`);
  }

  return manifest;
}

/** Verify the printable HTML build pack lists every plate (gallery + schedule). */
export function assertHtmlBuildPackIntegrity(_project: Project, model: Model, html: string): void {
  const n = model.sliced.plates.length;
  const legend = html.match(/data-plate-count="(\d+)"/);
  if (!legend || Number(legend[1]) !== n) {
    throw new BuildPackIntegrityError(`Build pack HTML legend plate count ${legend?.[1] ?? 'missing'} ≠ model ${n}`);
  }
  const gallery = html.match(/class="plate-gallery"[^>]*data-plate-count="(\d+)"/);
  if (!gallery || Number(gallery[1]) !== n) {
    throw new BuildPackIntegrityError(`Build pack HTML gallery plate count ${gallery?.[1] ?? 'missing'} ≠ model ${n}`);
  }
  const cards = html.match(/class="plate-card"/g)?.length ?? 0;
  if (cards !== n) {
    throw new BuildPackIntegrityError(`Build pack HTML gallery has ${cards} cards, model has ${n} plates`);
  }
  for (const pl of model.sliced.plates) {
    if (!html.includes(`data-plate-key="${pl.def.key}"`)) {
      throw new BuildPackIntegrityError(`Build pack HTML gallery missing plate ${pl.def.key}`);
    }
  }
  const mainParts = model.sliced.parts.filter((p) => p.family === 'P' || p.family === 'X' || p.family === 'R');
  for (const p of mainParts) {
    if (!html.includes(`<td class="id">${p.id}</td>`)) {
      throw new BuildPackIntegrityError(`Build pack HTML schedule missing part ${p.id}`);
    }
  }
  if (!html.includes('id="show-spacers"') || !html.includes('hide-spacers')) {
    throw new BuildPackIntegrityError('Build pack HTML missing spacer visibility toggle');
  }
}
