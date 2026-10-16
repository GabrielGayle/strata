// Deep audit: model plates vs zip files vs build-pack HTML drawings (not just counts).
import { unzipSync, strFromU8 } from 'fflate';
import { buildPackHtml } from './buildPack';
import { angledPlatePathCount } from './buildPack';
import type { Model } from './pipeline';
import type { Project } from './project';
import type { Part } from './slicer';
import { buildZip } from './exporters';
import { buildPlateManifest, dxfHasEntities, laserPartPath, svgHasPaths } from './buildPackIntegrity';

export interface PlateAuditIssue {
  scenario: string;
  plateKey: string;
  kind:
    | 'no_parts'
    | 'missing_laser_dxf'
    | 'empty_laser_dxf'
    | 'missing_plate_dxf'
    | 'empty_plate_dxf'
    | 'missing_plate_svg'
    | 'empty_plate_svg'
    | 'schedule_missing_part'
    | 'angled_missing'
    | 'plan_svg_empty'
    | 'elevation_svg_empty';
  detail: string;
}

const isMain = (p: Part) => p.family === 'P' || p.family === 'X' || p.family === 'R';

function scheduleMissing(html: string, parts: Part[]): string[] {
  return parts.filter((p) => !html.includes(`<td class="id">${p.id}</td>`)).map((p) => p.id);
}

/** Per-plate laser + combined plate files in zip. */
export function auditZipPlates(scenario: string, model: Model, project: Project, zip: Uint8Array): PlateAuditIssue[] {
  const files = unzipSync(zip);
  const dec = new TextDecoder();
  const issues: PlateAuditIssue[] = [];
  const manifest = buildPlateManifest(model, project);

  for (const pl of model.sliced.plates) {
    const row = manifest.plates.find((r) => r.key === pl.def.key);
    if (!pl.parts.length) {
      issues.push({ scenario, plateKey: pl.def.key, kind: 'no_parts', detail: 'Plate def has zero laser parts' });
      continue;
    }
    for (const part of pl.parts) {
      const rel = laserPartPath(model, project, part);
      const data = files[rel];
      if (!data?.length) {
        issues.push({ scenario, plateKey: pl.def.key, kind: 'missing_laser_dxf', detail: `Missing ${rel} for ${part.id}` });
      } else if (!dxfHasEntities(dec.decode(data))) {
        issues.push({ scenario, plateKey: pl.def.key, kind: 'empty_laser_dxf', detail: `Empty DXF ${rel}` });
      }
    }
    if (!row) continue;
    for (const rel of [row.dxf, row.svg]) {
      const data = files[rel];
      const kind = rel.endsWith('.dxf') ? 'missing_plate_dxf' : 'missing_plate_svg';
      const emptyKind = rel.endsWith('.dxf') ? 'empty_plate_dxf' : 'empty_plate_svg';
      if (!data?.length) issues.push({ scenario, plateKey: pl.def.key, kind, detail: `Missing ${rel}` });
      else if (rel.endsWith('.dxf') && !dxfHasEntities(dec.decode(data))) {
        issues.push({ scenario, plateKey: pl.def.key, kind: emptyKind, detail: rel });
      } else if (rel.endsWith('.svg') && !svgHasPaths(dec.decode(data))) {
        issues.push({ scenario, plateKey: pl.def.key, kind: emptyKind, detail: rel });
      }
    }
  }
  return issues;
}

/** HTML schedule + angled cover + crude plan/elevation path presence. */
export function auditHtmlPlates(scenario: string, model: Model, project: Project, html: string): PlateAuditIssue[] {
  const issues: PlateAuditIssue[] = [];
  const mainParts = model.sliced.parts.filter(isMain);
  for (const id of scheduleMissing(html, mainParts)) {
    const pl = model.sliced.plates.find((p) => p.parts.some((q) => q.id === id));
    issues.push({
      scenario,
      plateKey: pl?.def.key ?? '?',
      kind: 'schedule_missing_part',
      detail: `Schedule missing part ${id}`,
    });
  }
  const { drawn, expected } = angledPlatePathCount(project, model, { maxH: 400 });
  if (drawn < expected) {
    for (const p of mainParts) {
      // coarse: if total short, list all plate keys once
      issues.push({
        scenario,
        plateKey: p.plateKey,
        kind: 'angled_missing',
        detail: `Angled cover draws ${drawn}/${expected} main-part paths (part ${p.id} may be clipped or empty path)`,
      });
    }
    // dedupe by plateKey
    const seen = new Set<string>();
    return issues.filter((i) => {
      if (i.kind !== 'angled_missing') return true;
      if (seen.has(i.plateKey)) return false;
      seen.add(i.plateKey);
      return true;
    });
  }
  // Plan: row mode uses fill="#111" per main part path; flat uses stroke paths
  const flat = model.v.sliceMode === 'flat';
  if (!flat) {
    const planBlock = html.match(/id="layout"[\s\S]*?<\/section>/)?.[0] ?? '';
    const blackPaths = (planBlock.match(/fill="#111"/g) ?? []).length;
    const pCount = mainParts.filter((p) => p.family === 'P').length;
    if (blackPaths < pCount) {
      issues.push({
        scenario,
        plateKey: '*',
        kind: 'plan_svg_empty',
        detail: `Plan layout has ${blackPaths} solid plate paths, expected at least ${pCount} P parts (overlap/z-order may hide; paths may be empty)`,
      });
    }
  }
  return issues;
}

export function auditScenario(scenario: string, model: Model, project: Project): PlateAuditIssue[] {
  const zip = buildZip(model, project);
  const html = buildPackHtml(project, model);
  return [...auditZipPlates(scenario, model, project, zip), ...auditHtmlPlates(scenario, model, project, html)];
}
