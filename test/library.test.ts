import { describe, expect, it } from 'vitest';
import { newProject } from '../src/core/project';
import {
  duplicateEntry, fingerprint, hasUnsavedChanges, memoryLibrary, openEntry, projectFingerprint, recentEntries, renameEntry, saveAs, saveOver, sortEntries, uniqueName,
  type LibraryMeta,
} from '../src/state/library';

const meta = (id: string, savedAt: number, openedAt: number): LibraryMeta => ({ id, name: id, savedAt, openedAt, size: 1 });

describe('project library', () => {
  it('saves a project with its images and opens it back', async () => {
    const store = memoryLibrary();
    const p = { ...newProject(), images: { top: { name: 't.png', dataUrl: 'data:image/png;base64,AAAA' } } };
    const { meta: m, project } = await saveAs(store, p, 'First', 'data:image/jpeg;base64,xx', 1000);
    expect(project.name).toBe('First');
    expect(m).toMatchObject({ name: 'First', savedAt: 1000, openedAt: 1000, thumb: 'data:image/jpeg;base64,xx' });
    const opened = await openEntry(store, m.id, 2000);
    expect(opened.project.images.top?.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(opened.project.name).toBe('First');
    expect((await store.getMeta(m.id))!.openedAt).toBe(2000);
  });

  it('save overwrites and keeps the old picture when none is given', async () => {
    const store = memoryLibrary();
    const { meta: m, project } = await saveAs(store, newProject(), 'A', 'thumb1', 1);
    const changed = { ...project, params: { ...project.params, plateCount: '12' } };
    const m2 = await saveOver(store, m.id, changed, undefined, 5);
    expect(m2.thumb).toBe('thumb1');
    expect(m2.savedAt).toBe(5);
    expect((await openEntry(store, m.id)).project.params.plateCount).toBe('12');
    await expect(saveOver(store, 'gone', changed)).rejects.toThrow(/no longer/);
  });

  it('renames, duplicates and deletes', async () => {
    const store = memoryLibrary();
    const { meta: m } = await saveAs(store, newProject(), 'Bloom', undefined, 1);
    await renameEntry(store, m.id, 'Big bloom');
    expect((await openEntry(store, m.id)).project.name).toBe('Big bloom');
    const d1 = await duplicateEntry(store, m.id, 2);
    const d2 = await duplicateEntry(store, m.id, 3);
    expect([d1.name, d2.name]).toEqual(['Big bloom copy', 'Big bloom copy 2']);
    expect(d1.id).not.toBe(m.id);
    expect((await openEntry(store, d1.id)).project.name).toBe('Big bloom copy');
    await store.remove(m.id);
    expect((await store.list()).map((x) => x.name).sort()).toEqual(['Big bloom copy', 'Big bloom copy 2']);
    expect(await store.getData(m.id)).toBeUndefined();
  });

  it('sorts by save time and lists the five most recently opened', () => {
    const list = [meta('a', 1, 10), meta('b', 3, 0), meta('c', 2, 30), meta('d', 4, 20), meta('e', 5, 5), meta('f', 6, 1), meta('g', 7, 2)];
    expect(sortEntries(list).map((m) => m.id)).toEqual(['g', 'f', 'e', 'd', 'b', 'c', 'a']);
    expect(recentEntries(list).map((m) => m.id)).toEqual(['c', 'd', 'a', 'e', 'g']);
  });

  it('finds unclashing names', () => {
    expect(uniqueName('X', [])).toBe('X');
    expect(uniqueName('X', ['x', 'X 2'])).toBe('X 3');
    expect(uniqueName('  ', [])).toBe('Untitled');
  });

  it('tells whether the working copy moved on from its entry', () => {
    const p = newProject();
    const link = { id: 'p1', print: projectFingerprint(p) };
    expect(hasUnsavedChanges(p, link)).toBe(false);
    expect(hasUnsavedChanges({ ...p, params: { ...p.params, plateCount: '9' } }, link)).toBe(true);
    expect(hasUnsavedChanges(p, undefined)).toBe(true);
    expect(fingerprint('ab')).not.toBe(fingerprint('ba'));
  });
});
