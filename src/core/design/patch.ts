import { previewAutoDimension } from '../autoDimension';
import { applyParamPatchRespectingOverrides, masterSizeBlocked } from '../projectOverrides';
import { wordsParamPatch } from '../chantWords';
import { masterSizePresetPatch, parseMasterOrientation, resolveMasterSizeCli } from '../masterPresets';
import { type RawValue } from '../params';
import { applyPreset, PRESETS, type Project } from '../project';
import { speechParamPatch } from '../speechTuning';
import { projectWithTopMapSpec } from '../mapTopAsset';
import { unionMapBbox } from '../mapPresets';
import type { ProjectPatch } from './types';

/** Expand tuning side effects (same as the param panel). */
export function enrichParamPatch(params: Record<string, RawValue>): Record<string, RawValue> {
  const out = { ...params };
  if (String(out.tuneMode) === 'words') {
    Object.assign(out, wordsParamPatch(String(out.tuneWords ?? ''), String(out.tuneMelodyRoot ?? 'G4')));
  }
  if (String(out.tuneMode) === 'speech') {
    Object.assign(
      out,
      speechParamPatch(
        String(out.tuneWords ?? ''),
        String(out.tuneMelodyRoot ?? 'G4'),
        String(out.tuneSpeechPlates ?? '2'),
        out.tuneSpeechFundamental !== false && out.tuneSpeechFundamental !== 'false',
      ),
    );
  }
  return out;
}

export function emptyPatch(): ProjectPatch {
  return {};
}

export function mergePatches(...parts: ProjectPatch[]): ProjectPatch {
  const out: ProjectPatch = {};
  for (const p of parts) {
    if (p.preset) out.preset = p.preset;
    if (p.masterSize) out.masterSize = p.masterSize;
    if (p.name) out.name = p.name;
    if (p.params) out.params = { ...out.params, ...p.params };
    if (p.autoDimension) {
      const prev = out.autoDimension ?? { faces: [], reliefExaggeration: 1 };
      const faces = [...prev.faces];
      for (const f of p.autoDimension.faces) if (!faces.includes(f)) faces.push(f);
      out.autoDimension = {
        faces,
        reliefExaggeration: p.autoDimension.reliefExaggeration ?? prev.reliefExaggeration,
      };
    }
    if (p.map) {
      const prev = out.map;
      const bbox =
        prev?.bbox && p.map.bbox ? unionMapBbox(prev.bbox, p.map.bbox) : (p.map.bbox ?? prev?.bbox);
      out.map = { ...prev, ...p.map, ...(bbox ? { bbox } : {}) };
    }
  }
  return out;
}

function resolvePreset(name: string) {
  const lower = name.toLowerCase();
  return PRESETS.find((p) => p.name.toLowerCase() === lower || p.name.toLowerCase().replace(/\s+/g, '') === lower.replace(/\s+/g, ''));
}

/** Apply a patch onto a project (preset first, then master size, then param overrides). */
export function applyProjectPatch(project: Project, patch: ProjectPatch): Project {
  let p = project;
  if (patch.preset) {
    const preset = resolvePreset(patch.preset);
    if (preset) p = applyPreset(p, preset);
  }
  let params = { ...p.params };
  if (patch.masterSize && !masterSizeBlocked(p.userParamOverrides)) {
    const id = resolveMasterSizeCli(patch.masterSize.id);
    const ori = patch.masterSize.orientation ?? 'portrait';
    Object.assign(params, masterSizePresetPatch(params, id, ori));
  }
  if (patch.params) params = enrichParamPatch({ ...params, ...patch.params });
  if (patch.autoDimension?.faces.length) {
    const relief = patch.autoDimension.reliefExaggeration ?? 1;
    for (const face of patch.autoDimension.faces) {
      const preview = previewAutoDimension(face, p.images[face]?.depth, params, { reliefExaggeration: relief });
      if (preview.ok) params = applyParamPatchRespectingOverrides(params, preview.patch, p.userParamOverrides);
    }
  }
  if (patch.name) p = { ...p, name: patch.name };
  if (patch.map) {
    const prev = p.images.top?.map;
    const bbox = patch.map.bbox ?? prev?.bbox;
    if (!bbox) throw new Error('Map patch requires a bbox');
    p = projectWithTopMapSpec(p, { ...patch.map, bbox });
  }
  return { ...p, params };
}

export interface ParamChange {
  id: string;
  before: string;
  after: string;
}

export function diffProjectPatch(project: Project, patch: ProjectPatch): { changes: ParamChange[]; preset?: string; name?: string } {
  const before = project.params;
  const after = applyProjectPatch(project, patch).params;
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: ParamChange[] = [];
  for (const id of ids) {
    const b = String(before[id] ?? '');
    const a = String(after[id] ?? '');
    if (b !== a) changes.push({ id, before: b, after: a });
  }
  changes.sort((x, y) => x.id.localeCompare(y.id));
  return {
    changes,
    preset: patch.preset,
    name: patch.name !== project.name ? patch.name : undefined,
  };
}

export function formatPatchDiff(project: Project, patch: ProjectPatch): string {
  const { changes, preset, name } = diffProjectPatch(project, patch);
  const lines: string[] = [];
  if (preset) lines.push(`preset: → ${preset}`);
  if (name) lines.push(`name: ${project.name} → ${name}`);
  for (const c of changes) lines.push(`${c.id}: ${c.before} → ${c.after}`);
  return lines.join('\n');
}

export function masterSizePatch(size: string, orientation?: string): ProjectPatch {
  return {
    masterSize: {
      id: size,
      orientation: orientation == null ? 'portrait' : parseMasterOrientation(orientation),
    },
  };
}
