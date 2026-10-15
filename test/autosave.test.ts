import { describe, expect, it, vi } from 'vitest';
import { createSaver, memoryKV, readWithLegacy, type KV, type SaveStatus } from '../src/state/persist';
import { newProject, serialize } from '../src/core/project';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('autosave', () => {
  it('reports saving, then saved once the write lands', async () => {
    const kv = memoryKV();
    const seen: SaveStatus[] = [];
    const s = createSaver(kv, (st) => seen.push(st));
    await s.save('a', '1');
    expect(await kv.get('a')).toBe('1');
    expect(seen[0]).toBe('saving');
    expect(seen.at(-1)).toBe('saved');
  });

  it('reports a failed write once, and recovers on the next good save', async () => {
    let full = true;
    const store = new Map<string, string>();
    const kv: KV = {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        if (full) throw new DOMException('quota', 'QuotaExceededError');
        store.set(k, v);
      },
    };
    const onStatus = vi.fn();
    const s = createSaver(kv, onStatus);
    await s.save('p', 'x');
    await s.save('p', 'y');
    expect(onStatus.mock.calls.filter(([st]) => st === 'failed')).toHaveLength(1);
    expect(onStatus.mock.calls.at(-1)![0]).toBe('failed');
    full = false;
    await s.save('p', 'z');
    expect(store.get('p')).toBe('z');
    expect(onStatus.mock.calls.at(-1)![0]).toBe('saved');
  });

  it('keeps only the latest value when writes queue up', async () => {
    const writes: string[] = [];
    let release!: () => void;
    const kv: KV = {
      get: async () => undefined,
      set: (_k, v) => {
        writes.push(v);
        return v === '1' ? new Promise<void>((r) => (release = r)) : Promise.resolve();
      },
    };
    const s = createSaver(kv, () => {});
    void s.save('p', '1');
    void s.save('p', '2');
    void s.save('p', '3');
    await tick();
    release();
    await s.flush();
    expect(writes).toEqual(['1', '3']);
  });

  it('holds a project with images far beyond localStorage size', async () => {
    const p = newProject();
    p.images.top = { name: 'big.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(8_000_000) };
    const kv = memoryKV();
    const s = createSaver(kv, () => {});
    await s.save('strata.project.v1', serialize(p));
    expect((await kv.get('strata.project.v1'))!.length).toBeGreaterThan(8_000_000);
  });

  it('falls back to the old localStorage copy the first time', async () => {
    const legacy = { getItem: (k: string) => (k === 'k' ? 'old' : null) } as Storage;
    expect(await readWithLegacy(memoryKV(), 'k', legacy)).toBe('old');
    expect(await readWithLegacy(memoryKV({ k: 'new' }), 'k', legacy)).toBe('new');
  });
});
