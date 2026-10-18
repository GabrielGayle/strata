import { describe, expect, it } from 'vitest';
import { deserialize, newProject, serialize, type ImageAsset } from '../src/core/project';
import { cleanMapSpec, defaultMapSpec, parseBbox } from '../src/core/mapSpec';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const example = readFileSync(fileURLToPath(new URL('../examples/image-cliff.strata.json', import.meta.url)), 'utf8');

describe('MapSpec schema', () => {
  it('round-trips map on an image asset through project JSON', () => {
    const p = newProject();
    const map = defaultMapSpec({
      bbox: [-0.28, 51.543, -0.233, 51.575],
      source: 'terrarium',
      title: 'Neasden',
      resM: 8,
    });
    const asset: ImageAsset = {
      name: 'Neasden terrain',
      dataUrl: 'data:image/png;base64,AAAA',
      map,
    };
    p.images.top = asset;
    const text = serialize(p);
    expect(text).toContain('"kind":"map"');
    const back = deserialize(text);
    expect(back.images.top?.map).toEqual(map);
    expect(back.images.top?.depth).toBeUndefined();
  });

  it('loads older projects without map fields', () => {
    const back = deserialize(example);
    expect(back.images.top?.map).toBeUndefined();
    expect(back.params.plateCount).toBe('24');
  });

  it('drops invalid map specs on load', () => {
    const p = newProject();
    p.images.top = { name: 'x', dataUrl: 'data:image/png;base64,AAAA', map: { kind: 'map', bbox: [0, 0, 0, 0] } as never };
    const back = deserialize(serialize(p));
    expect(back.images.top?.map).toBeUndefined();
  });

  it('parses bbox strings', () => {
    expect(parseBbox('-0.28,51.543,-0.233,51.575')).toEqual([-0.28, 51.543, -0.233, 51.575]);
    expect(() => parseBbox('bad')).toThrow(/four numbers/);
  });

  it('cleans engrave defaults (on by default)', () => {
    const m = cleanMapSpec({ kind: 'map', bbox: [0, 0, 1, 1], source: 'terrarium' });
    expect(m?.engrave.enabled).toBe(true);
    expect(m?.engrave.features.length).toBeGreaterThan(0);
  });

  it('loads saves with the removed cop30 source as terrarium (what they always built from)', () => {
    expect(cleanMapSpec({ kind: 'map', bbox: [0, 0, 1, 1], source: 'cop30' })?.source).toBe('terrarium');
    expect(cleanMapSpec({ kind: 'map', bbox: [0, 0, 1, 1], source: 'nonsense' })?.source).toBe('auto');
  });
});
