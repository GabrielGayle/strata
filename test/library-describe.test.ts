import { describe, expect, it } from 'vitest';
import { newProject } from '../src/core/project';
import { filterLibrary, foldersOf, projectKind, sortLibrary } from '../src/state/libraryDescribe';
import { memoryLibrary, saveAs, type LibraryMeta } from '../src/state/library';
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
    expect(b.plateCount).toBe(40);
    expect((await store.list()).length).toBe(1);
  });
});
