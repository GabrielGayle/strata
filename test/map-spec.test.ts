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
    expect(text).toContain('"kind": "map"');
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

  it('round-trips a fractional exaggeration through save and load', () => {
    const p = newProject();
    const map = defaultMapSpec({
      bbox: [-0.03, 51.465, 0.124, 51.505],
      source: 'ea-dtm',
      title: 'Woolwich',
      exaggeration: 1.5,
    });
    p.images.top = { name: 'Woolwich', dataUrl: 'data:image/png;base64,AAAA', map };
    const back = deserialize(serialize(p));
    expect(back.images.top?.map?.exaggeration).toBe(1.5);
    expect(cleanMapSpec({ kind: 'map', bbox: [0, 0, 1, 1], exaggeration: 1.25 })?.exaggeration).toBe(1.25);
  });

  it('loads integer exaggeration from older projects unchanged', () => {
    const p = newProject();
    p.images.top = {
      name: 'Neasden',
      dataUrl: 'data:image/png;base64,AAAA',
      map: defaultMapSpec({ bbox: [-0.28, 51.543, -0.233, 51.575], exaggeration: 21 }),
    };
    const back = deserialize(serialize(p));
    expect(back.images.top?.map?.exaggeration).toBe(21);
    expect(cleanMapSpec({ kind: 'map', bbox: [0, 0, 1, 1], exaggeration: 4 })?.exaggeration).toBe(4);
    expect(cleanMapSpec({ kind: 'map', bbox: [0, 0, 1, 1], exaggeration: 11 })?.exaggeration).toBe(11);
  });
});
