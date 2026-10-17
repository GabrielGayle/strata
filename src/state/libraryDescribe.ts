import { METAL_NAMES } from '../core/appearance';
import { createPipeline, type Assets } from '../core/pipeline';
import type { Project } from '../core/project';
import type { LibraryMeta, ProjectKind } from './library';

const EMPTY_ASSETS: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

/** Sliced plate count from a rebuild — not `params.plateCount`, which can be a leftover or an expression. */
export function rebuildPlateCount(p: Project, assets: Assets = EMPTY_ASSETS): number {
  return createPipeline()(p, assets).sliced.plates.length;
}

export type LibrarySort = 'updated' | 'name' | 'plates' | 'kind';

export function projectKind(p: Project): ProjectKind {
  const top = p.images.top;
  if (top?.map || top?.depth?.mapOrtho) return 'Map';
  if (p.params.sliceMode === 'flat') return 'Stamped';
  const sideOn = !!p.images.side || String(p.params.imgSideMode ?? 'off') !== 'off';
  const frontOn = !!p.images.front || String(p.params.imgFrontMode ?? 'off') !== 'off';
  if (sideOn || frontOn) return 'Image';
  return 'Vermilion';
}

export function plateCountOf(p: Project, plates?: number): number | undefined {
  if (typeof plates === 'number' && Number.isFinite(plates)) return plates;
  try {
    return rebuildPlateCount(p);
  } catch {
    return undefined;
  }
}

export function materialOfProject(p: Project): string {
  const id = String(p.params.plateMaterial ?? 'corten');
  return METAL_NAMES[id] ?? id;
}

export function describeProject(p: Project, plates?: number): Pick<LibraryMeta, 'kind' | 'plateCount' | 'material'> {
  return {
    kind: projectKind(p),
    plateCount: plateCountOf(p, plates),
    material: materialOfProject(p),
  };
}

export function filterLibrary(list: LibraryMeta[], q: string, folder?: string | null): LibraryMeta[] {
  const s = q.trim().toLowerCase();
  return list.filter((m) => {
    if (folder && (m.folder ?? '') !== folder) return false;
    if (!s) return true;
    const bag = [m.name, m.kind, m.material, m.folder, m.source, ...(m.tags ?? []), m.plateCount != null ? String(m.plateCount) : ''].join(' ').toLowerCase();
    return bag.includes(s);
  });
}

export function sortLibrary(list: LibraryMeta[], by: LibrarySort): LibraryMeta[] {
  const out = [...list];
  if (by === 'name') return out.sort((a, b) => a.name.localeCompare(b.name) || (b.updatedAt ?? b.savedAt) - (a.updatedAt ?? a.savedAt));
  if (by === 'plates') return out.sort((a, b) => (b.plateCount ?? -1) - (a.plateCount ?? -1) || a.name.localeCompare(b.name));
  if (by === 'kind') return out.sort((a, b) => (a.kind ?? '').localeCompare(b.kind ?? '') || a.name.localeCompare(b.name));
  return out.sort((a, b) => (b.updatedAt ?? b.savedAt) - (a.updatedAt ?? a.savedAt));
}

export function foldersOf(list: LibraryMeta[]): string[] {
  return [...new Set(list.map((m) => m.folder).filter((x): x is string => !!x?.trim()))].sort((a, b) => a.localeCompare(b));
}
