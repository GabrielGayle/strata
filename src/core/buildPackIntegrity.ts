// Build-pack integrity: every plate in the model must appear in the fabrication
// zip (manifest + per-plate files + laser parts) and in the printable HTML.
import { bboxOf, type BBox } from './geom2d';
import { materialOf } from './appearance';
import { angledPlatePathCount } from './buildPack';
import type { Model } from './pipeline';
import type { Project } from './project';
import type { Part } from './slicer';

export class BuildPackIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildPackIntegrityError';
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

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
  return `laser/parts/${mixed ? `${safe(metal)}/` : ''}${safe(part.id)}.dxf`;
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

/** One row per `sliced.plates` entry (the model's plate list). */
export function buildPlateManifest(model: Model, project: Project): BuildPackManifest {
  const plates: PlateManifestEntry[] = model.sliced.plates.map((pl) => {
    const bb = pl.parts.length ? plateBBox(pl.parts) : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const key = pl.def.key;
    return {
      index: pl.def.index,
      key,
      family: pl.def.family,
      name: plateName(pl.parts),
      widthMm: bb.maxX - bb.minX,
      heightMm: bb.maxY - bb.minY,
      thicknessMm: pl.parts[0]?.thickness ?? model.v.thickness,
      layer: pl.def.index,
      dxf: `plates/${safe(key)}.dxf`,
      svg: `plates/${safe(key)}.svg`,
      partIds: pl.parts.map((p) => p.id),
      partFiles: pl.parts.map((p) => laserPartPath(model, project, p)),
    };
  });
  return { version: 1, plateCount: plates.length, plates };
}

export function dxfHasEntities(text: string): boolean {
  return text.includes('ENTITIES') && /0\s+LINE|0\s+POLYLINE|0\s+ARC/i.test(text);
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
    if (!pl.parts.length) {
      throw new BuildPackIntegrityError(`Plate ${row.key} has no laser parts in the model but is listed in the manifest`);
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
      const fn = `${safe(id)}.dxf`;
      if (!names.has(fn)) throw new BuildPackIntegrityError(`Zip has no unique entry for part ${id} (${fn})`);
    }
  }

  const manifestBytes = files['manifest.json'];
  if (!manifestBytes?.length) throw new BuildPackIntegrityError('manifest.json missing from fabrication zip');
  const onDisk = JSON.parse(dec.decode(manifestBytes)) as BuildPackManifest;
  if (onDisk.plateCount !== manifest.plateCount) {
    throw new BuildPackIntegrityError(`manifest.json plateCount ${onDisk.plateCount} ≠ model ${manifest.plateCount}`);
  }

  return manifest;
}

/** Verify the printable HTML build pack lists and draws every main plate. */
export function assertHtmlBuildPackIntegrity(_project: Project, model: Model, html: string): void {
  const mainParts = model.sliced.parts.filter((p) => p.family === 'P' || p.family === 'X' || p.family === 'R');
  for (const p of mainParts) {
    if (!html.includes(`<td class="id">${p.id}</td>`)) {
      throw new BuildPackIntegrityError(`Build pack HTML schedule missing part ${p.id}`);
    }
  }
  const { drawn, expected } = angledPlatePathCount(_project, model, { maxH: 400 });
  if (drawn !== expected) {
    throw new BuildPackIntegrityError(`Build pack angled cover draws ${drawn} plates, expected ${expected}`);
  }
  const planPaths = (html.match(/fill="#111"/g) ?? []).length;
  const flat = model.v.sliceMode === 'flat';
  if (!flat && planPaths < mainParts.filter((p) => p.family === 'P').length) {
    throw new BuildPackIntegrityError(`Build pack plan layout missing plate outlines (${planPaths} drawn)`);
  }
  if (model.sliced.plates.length !== manifestPlateKeys(model).length) {
    throw new BuildPackIntegrityError('Model plate list length mismatch during HTML check');
  }
}

function manifestPlateKeys(model: Model): string[] {
  return model.sliced.plates.map((p) => p.def.key);
}
