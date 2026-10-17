import { describe, expect, it } from 'vitest';
import { newProject, serialize } from '../src/core/project';
import { exportLibrary, importLibrary, memoryLibrary, openEntry, saveAs } from '../src/state/library';
import { isOneOffAddress, requestPersistentStorage } from '../src/state/persist';

describe('moving the library between addresses', () => {
  it('exports every project and imports them into an empty library', async () => {
    const from = memoryLibrary();
    const p = { ...newProject(), images: { top: { name: 't.png', dataUrl: 'data:image/png;base64,AAAA' } } };
    await saveAs(from, p, 'Bloom', 'thumb', 1);
    await saveAs(from, newProject(), 'Ridge', undefined, 2);
    const { text, count } = await exportLibrary(from);
    expect(count).toBe(2);

    const to = memoryLibrary();
    const r = await importLibrary(to, text);
    expect(r.added.sort()).toEqual(['Bloom', 'Ridge']);
    const list = await to.list();
    const bloom = list.find((m) => m.name === 'Bloom')!;
    expect(bloom.thumb).toBe('thumb');
    expect((await openEntry(to, bloom.id)).project.images.top?.dataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('skips projects already there and renames clashing ones', async () => {
    const lib = memoryLibrary();
    await saveAs(lib, newProject(), 'Bloom', undefined, 1);
    const { text } = await exportLibrary(lib);
    expect(await importLibrary(lib, text)).toEqual({ added: [], skipped: 1 });

    const other = memoryLibrary();
    await saveAs(other, { ...newProject(), params: { ...newProject().params, plateCount: '9' } }, 'Bloom', undefined, 5);
    const r = await importLibrary(lib, (await exportLibrary(other)).text);
    expect(r.added).toEqual(['Bloom (2)']);
    const m = (await lib.list()).find((x) => x.name === 'Bloom (2)')!;
    expect((await openEntry(lib, m.id)).project.name).toBe('Bloom (2)');
  });

  it('takes a single project file too, and refuses anything else', async () => {
    const lib = memoryLibrary();
    const r = await importLibrary(lib, serialize({ ...newProject(), name: 'Solo' }));
    expect(r.added).toEqual(['Solo']);
    await expect(importLibrary(lib, '{"hello":1}')).rejects.toThrow(/Not a Strata/);
  });
});

describe('site address and storage', () => {
  it('flags Vercel build addresses but not the main one', () => {
    expect(isOneOffAddress('strata-gamma-one.vercel.app')).toBe(false);
    expect(isOneOffAddress('strata-git-cursor-win98-gabrielgayles-projects.vercel.app')).toBe(true);
    expect(isOneOffAddress('strata-abc123def.vercel.app')).toBe(true);
    expect(isOneOffAddress('localhost:5173')).toBe(false);
  });

  it('asks for persistent storage when the browser offers it', async () => {
    let asked = 0;
    const nav = { storage: { persisted: async () => false, persist: async () => (asked++, true) } } as unknown as Navigator;
    expect(await requestPersistentStorage(nav)).toBe(true);
    expect(asked).toBe(1);
    expect(await requestPersistentStorage({} as Navigator)).toBe(false);
  });
});

describe('unreadable autosave', () => {
  it('is kept aside instead of being overwritten', async () => {
    const { memoryKV } = await import('../src/state/persist');
    const { hydrate } = await import('../src/state/store');
    const kv = memoryKV({ 'strata.project.v1': '{"format":"something-else"}' });
    await hydrate(kv);
    expect(await kv.get('strata.project.unreadable')).toBe('{"format":"something-else"}');
  });
});
