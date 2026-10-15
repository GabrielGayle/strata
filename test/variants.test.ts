import { describe, expect, it } from 'vitest';
import { applyVariant, deserialize, newProject, serialize, type Project, type Variant } from '../src/core/project';
import { DEFAULT_SOUND } from '../src/core/sound';

function variantOf(p: Project, name: string): Variant {
  return { id: name, name, params: { ...p.params }, locks: {}, pour: p.pour, images: { ...p.images }, composition: p.composition, createdAt: '' };
}

describe('variants', () => {
  it('bring back their own images, sound and composition', () => {
    const p = newProject();
    p.images.top = { name: 'a.png', dataUrl: 'data:a', sound: { ...DEFAULT_SOUND } };
    p.composition = { kind: 'composition', blocks: [] } as any;
    const v = variantOf(p, 'A');
    const later: Project = { ...p, images: { front: { name: 'b.png', dataUrl: 'data:b' } }, composition: undefined, variants: [v] };
    const back = applyVariant(later, v);
    expect(back.images.top?.dataUrl).toBe('data:a');
    expect(back.images.top?.sound).toEqual(DEFAULT_SOUND);
    expect(back.images.front).toBeUndefined();
    expect(back.composition).toEqual(p.composition);
  });

  it('saved before images were kept: leave the current images alone', () => {
    const p = newProject();
    p.images.top = { name: 'a.png', dataUrl: 'data:a' };
    const { images: _i, composition: _c, ...old } = variantOf(newProject(), 'old');
    expect(applyVariant(p, old as Variant).images.top?.dataUrl).toBe('data:a');
  });

  it('round-trip through the file without storing a shared image twice', () => {
    const p = newProject();
    p.images.top = { name: 'a.png', dataUrl: 'data:' + 'x'.repeat(10000) };
    p.images.side = { name: 's.png', dataUrl: 'data:side-old' };
    const v = variantOf(p, 'A');
    const cur: Project = { ...p, images: { ...p.images, side: { name: 's.png', dataUrl: 'data:side-new' } }, variants: [v] };
    const text = serialize(cur);
    expect(text.split('x'.repeat(10000)).length - 1).toBe(1);
    const back = deserialize(text);
    expect(back.variants[0].images?.top?.dataUrl).toBe(p.images.top.dataUrl);
    expect(back.variants[0].images?.side?.dataUrl).toBe('data:side-old');
    expect(back.images.side?.dataUrl).toBe('data:side-new');
  });
});
