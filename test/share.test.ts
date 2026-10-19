import { describe, expect, it } from 'vitest';
import { newProject, type Project } from '../src/core/project';
import { newObject } from '../src/core/objects';
import { DEFAULT_SHELF } from '../src/core/shelf';
import { decodeShare, encodeShare, fromBase64Url, LONG_LINK, omittedFrom, projectFromShare, shareCodeFromHash, shareLink, shareState, toBase64Url } from '../src/core/share';

const BIG = 'data:image/png;base64,' + 'A'.repeat(200_000);

function rich(): Project {
  const p = newProject();
  return {
    ...p,
    name: 'Shared piece',
    params: { ...p.params, plateCount: '33', sliceMode: 'radial', pitch: 'baseLength / 20' },
    locks: { plateCount: true },
    pour: [{ id: 'p1', name: 'Only band', height: 'baseHeight', color: '#123456' }],
    moves: { P3: { t: [1, 2, 3], q: [0, 0, 0, 1] } },
    appearance: { buckets: [{ id: 'b1', name: 'Alu', material: 'aluminium' }], assign: { P3: 'b1' } },
    images: { top: { name: 'top.png', dataUrl: BIG }, side: { name: 'side.png', dataUrl: BIG } },
    meshes: { ins: { name: 'fin.stl', format: 'stl', data: 'AAAA' } },
    shadow: { frames: [{ id: 'f1', name: 'cat', dataUrl: BIG, time: 10, hold: 0 }] },
    variants: [
      { id: 'v1', name: 'Taller', params: { stackHeight: '300' }, locks: {}, pour: p.pour, images: { top: { name: 'top.png', dataUrl: BIG } }, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

describe('share links', () => {
  it('round-trips the settings through a compressed code', async () => {
    const p = rich();
    const code = await encodeShare(shareState(p), { compress: true });
    expect(code[0]).toBe('z');
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = projectFromShare(await decodeShare(code));
    expect(back.name).toBe('Shared piece');
    expect(back.params).toEqual(p.params);
    expect(back.locks).toEqual(p.locks);
    expect(back.pour).toEqual(p.pour);
    expect(back.moves).toEqual(p.moves);
    expect(back.appearance?.assign).toEqual({ P3: 'b1' });
    expect(back.variants.map((v) => [v.name, v.params])).toEqual([['Taller', { stackHeight: '300' }]]);
  });

  it('round-trips without compression', async () => {
    const p = rich();
    const code = await encodeShare(shareState(p), { compress: false });
    expect(code[0]).toBe('j');
    expect(projectFromShare(await decodeShare(code)).params).toEqual(p.params);
  });

  it('leaves images, meshes and shadow pictures out, and says so', async () => {
    const p = rich();
    const { url, omitted, long } = await shareLink(p, 'https://strata.example/app/#old', { compress: true });
    expect(url.startsWith('https://strata.example/app/#s=z')).toBe(true);
    expect(url.length).toBeLessThan(LONG_LINK);
    expect(long).toBe(false);
    expect(url).not.toContain('AAAAAAAA');
    const back = projectFromShare(await decodeShare(shareCodeFromHash(new URL(url).hash)!));
    expect(back.images).toEqual({});
    expect(back.meshes).toEqual({});
    expect(back.shadow).toBeUndefined();
    expect(back.variants[0].images).toBeUndefined();
    expect(omitted.join(' | ')).toMatch(/top, side images/);
    expect(omitted.join(' | ')).toMatch(/mesh/);
    expect(omitted.join(' | ')).toMatch(/shadow picture/);
    const s = shareState(p);
    expect(JSON.stringify(s)).not.toContain('data:image');
    expect(s.omitted).toEqual(omitted);
  });

  it('a plain project leaves nothing out and stays short', async () => {
    const p = newProject();
    expect(omittedFrom(p)).toEqual([]);
    const { url } = await shareLink(p, 'https://x.test/', { compress: true });
    expect(url.length).toBeLessThan(3500);
  });

  it('reads the code from a hash among other entries', () => {
    expect(shareCodeFromHash('#s=zabc')).toBe('zabc');
    expect(shareCodeFromHash('#foo=1&s=jxyz')).toBe('jxyz');
    expect(shareCodeFromHash('#s=')).toBeNull();
    expect(shareCodeFromHash('')).toBeNull();
  });

  it('rejects damaged and foreign codes', async () => {
    await expect(decodeShare('z!!!')).rejects.toThrow(/damaged/);
    await expect(decodeShare('zAAAA')).rejects.toThrow();
    await expect(decodeShare('j' + toBase64Url(new TextEncoder().encode('{"format":"other"}')))).rejects.toThrow(/Not a Strata/);
    await expect(decodeShare('q123')).rejects.toThrow(/Not a Strata/);
  });

  it('base64url round-trips every byte', () => {
    const bytes = new Uint8Array(256 * 3).map((_, i) => i % 256);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });

  it('carries cut objects, the postcard shelf and the world origin', async () => {
    const card = newObject('card', [], { y: 120 });
    const p: Project = { ...newProject(), objects: [card], shelf: { ...DEFAULT_SHELF, layout: 'arch', radius: 300 }, origin: { ref: 'corner', x: 5, y: 0, z: -3, turn: 15 } };
    p.variants = [{ id: 'v1', name: 'No shelf', params: {}, locks: {}, pour: p.pour, shelf: null, objects: [card], createdAt: '2026-01-01T00:00:00.000Z' }];
    const back = projectFromShare(await decodeShare(await encodeShare(shareState(p))));
    expect(back.objects).toEqual([card]);
    expect(back.shelf).toEqual(p.shelf);
    expect(back.origin).toEqual(p.origin);
    expect(back.variants[0].shelf).toBeNull();
    expect(back.variants[0].objects).toEqual([card]);
  });

  it('drops unknown parameters from a link', async () => {
    const s = shareState(newProject());
    s.params = { ...s.params, notAParam: '5' };
    const back = projectFromShare(await decodeShare(await encodeShare(s)));
    expect(back.params.notAParam).toBeUndefined();
  });
});
