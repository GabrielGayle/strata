import { METAL_NAMES } from '../core/appearance';
import { createPipeline, type Assets } from '../core/pipeline';
import type { Project } from '../core/project';
import type { LibraryMeta, ProjectKind } from './library';

const EMPTY_ASSETS: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

/** Sliced plate count from a rebuild — not `params.plateCount`, which can be a leftover or an expression. */
export function rebuildPlateCount(p: Project, assets: Assets = EMPTY_ASSETS): number {
  return createPipeline()(p, assets).sliced.plates.length;
}

/** SVG thumbnail of this project's plate stack, so imports don't all share the live 3D canvas. */
export function libraryThumbFromProject(p: Project, assets: Assets = EMPTY_ASSETS, w = 320, h = 220): string | undefined {
  try {
    const model = createPipeline()(p, assets);
    const plates = model.sliced.plates.filter((pl) => pl.parts.length);
    if (!plates.length) return undefined;
    let maxH = 1;
    const heights = plates.map((pl) => {
      let hi = 0;
      for (const part of pl.parts) hi = Math.max(hi, part.bbox.maxY - part.bbox.minY, part.bbox.maxX - part.bbox.minX);
      maxH = Math.max(maxH, hi);
      return hi;
    });
    const gap = 1.2;
    const barW = Math.max(1.2, (w - 24) / plates.length - gap);
    const bars = heights
      .map((hi, i) => {
        const bh = Math.max(4, (hi / maxH) * (h - 28));
        const x = 12 + i * (barW + gap);
        const y = h - 12 - bh;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="0.8" fill="#c45a2a" stroke="#2a1810" stroke-width="0.6"/>`;
      })
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ece8e1"/>${bars}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return undefined;
  }
}

export type LibrarySort = 'updated' | 'name' | 'plates' | 'kind';

export function sourceLabel(source?: LibraryMeta['source']): string | undefined {
  if (source === 'export') return 'Export';
  if (source === 'save') return 'Save';
  if (source === 'import') return 'Import';
  if (source === 'library') return 'Library';
  return undefined;
}

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

export function foldersOf(list: LibraryMeta[], extra: string[] = []): string[] {
  return [...new Set([...list.map((m) => m.folder), ...extra].filter((x): x is string => !!x?.trim()))].sort((a, b) => a.localeCompare(b));
}

/** How many saves sit in each folder. */
export function folderCounts(list: LibraryMeta[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of list) if (m.folder?.trim()) out.set(m.folder, (out.get(m.folder) ?? 0) + 1);
  return out;
}
