import { describe, expect, it } from 'vitest';
import { newProject } from '../src/core/project';
import { filterLibrary, foldersOf, libraryThumbFromProject, plateCountOf, projectKind, rebuildPlateCount, sortLibrary, sourceLabel } from '../src/state/libraryDescribe';
import { memoryLibrary, openEntry, saveAs, type LibraryMeta } from '../src/state/library';
import { recordLibrarySave } from '../src/state/recordLibrary';

describe('library describe', () => {
  it('classifies Vermilion, Stamped, Map and Image', () => {
    expect(projectKind(newProject())).toBe('Vermilion');
    expect(projectKind({ ...newProject(), params: { ...newProject().params, sliceMode: 'flat' } })).toBe('Stamped');
    expect(
      projectKind({
        ...newProject(),
        images: { top: { name: 't.png', dataUrl: 'data:image/png;base64,AA', map: { kind: 'map' } as never } },
      }),
    ).toBe('Map');
    expect(projectKind({ ...newProject(), images: { side: { name: 's.png', dataUrl: 'data:image/png;base64,AA' } } })).toBe('Image');
    expect(
      projectKind({
        ...newProject(),
        images: { top: { name: 'cliff.png', dataUrl: 'data:image/png;base64,AA' } },
      }),
    ).toBe('Vermilion');
    expect(projectKind({ ...newProject(), params: { ...newProject().params, imgSideMode: 'heightmap' } })).toBe('Image');
  });

  it('filters by search and folder, sorts by plates', () => {
    const list: LibraryMeta[] = [
      { id: 'a', name: 'Alpha', savedAt: 1, openedAt: 0, size: 1, kind: 'Vermilion', plateCount: 40, folder: 'Show', tags: ['hot'] },
      { id: 'b', name: 'Bravo', savedAt: 2, openedAt: 0, size: 1, kind: 'Stamped', plateCount: 11, material: 'Corten' },
    ];
    expect(filterLibrary(list, 'stamped').map((m) => m.id)).toEqual(['b']);
    expect(filterLibrary(list, 'hot').map((m) => m.id)).toEqual(['a']);
    expect(filterLibrary(list, '', 'Show').map((m) => m.id)).toEqual(['a']);
    expect(sortLibrary(list, 'plates').map((m) => m.id)).toEqual(['a', 'b']);
    expect(foldersOf(list)).toEqual(['Show']);
  });

  it('builds a distinct thumbnail from each project, not the live canvas', () => {
    const coarse = { ...newProject(), params: { ...newProject().params, plateCount: '6' } };
    const medium = { ...newProject(), params: { ...newProject().params, plateCount: '17', plateGap: '6' } };
    const fine = { ...newProject(), params: { ...newProject().params, plateCount: '41' } };
    const a = libraryThumbFromProject(coarse);
    const b = libraryThumbFromProject(medium);
    const c = libraryThumbFromProject(fine);
    expect(a?.startsWith('data:image/svg+xml')).toBe(true);
    expect(b).not.toBe(a);
    expect(c).not.toBe(b);
    expect(c).not.toBe(a);
  });

  it('records rebuilt plate count, not a leftover params.plateCount', () => {
    const p = {
      ...newProject(),
      params: { ...newProject().params, plateCount: '80', plateGap: '6', spacingMode: 'gap' },
    };
    expect(Number(p.params.plateCount)).toBe(80);
    expect(plateCountOf(p, 17)).toBe(17);
    expect(rebuildPlateCount(p)).not.toBe(80);
  });

  it('saveAs stores kind, plate count and material', async () => {
    const store = memoryLibrary();
    const p = { ...newProject(), params: { ...newProject().params, plateCount: '11', plateMaterial: 'aluminium', sliceMode: 'flat' } };
    const { meta } = await saveAs(store, p, 'Eleven', undefined, 9);
    expect(meta.kind).toBe('Stamped');
    expect(meta.plateCount).toBe(11);
    expect(meta.material).toBe('Aluminium');
    expect(meta.print).toBeTruthy();
  });

  it('recordLibrarySave overwrites the same fingerprint instead of duplicating', async () => {
    const store = memoryLibrary();
    const p = { ...newProject(), name: 'Once' };
    const a = await recordLibrarySave(p, { source: 'save' }, store);
    const b = await recordLibrarySave(p, { source: 'export', plates: 40 }, store);
    expect(b.id).toBe(a.id);
    expect(b.source).toBe('export');
    expect(sourceLabel(b.source)).toBe('Export');
    expect(b.plateCount).toBe(40);
    expect((await store.list()).length).toBe(1);
    expect((await store.list())[0].source).toBe('export');
  });

  it('does not replace a 19-plate Vermilion 40 with a same-name 17-plate export', async () => {
    const store = memoryLibrary();
    const nineteen = { ...newProject(), name: 'Vermilion 40', params: { ...newProject().params, plateCount: '19' } };
    const a = await recordLibrarySave(nineteen, { source: 'save', plates: 19 }, store);
    const medium = {
      ...newProject(),
      name: 'Vermilion 40',
      params: { ...newProject().params, plateCount: '17', plateGap: '6', spacingMode: 'gap' },
    };
    const b = await recordLibrarySave(medium, { source: 'export', plates: 17 }, store);
    expect(b.id).not.toBe(a.id);
    expect(b.name).toBe('Vermilion 40 (2)');
    expect(b.plateCount).toBe(17);
    expect((await openEntry(store, a.id)).project.params.plateCount).toBe('19');
    expect((await store.list()).length).toBe(2);
  });

  it('overwrites the linked project even when the fingerprint moved on', async () => {
    const store = memoryLibrary();
    const first = { ...newProject(), name: 'Vermilion 40', params: { ...newProject().params, plateCount: '19' } };
    const a = await recordLibrarySave(first, { source: 'save', plates: 19 }, store);
    const edited = { ...first, params: { ...first.params, plateCount: '21' } };
    const b = await recordLibrarySave(edited, { source: 'save', plates: 21, linkId: a.id }, store);
    expect(b.id).toBe(a.id);
    expect((await store.list()).length).toBe(1);
    expect((await openEntry(store, a.id)).project.params.plateCount).toBe('21');
  });
});
