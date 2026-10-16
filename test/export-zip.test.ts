import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject } from '../src/core/project';
import { buildZip } from '../src/core/exporters';
import { DEFAULT_RATES } from '../src/core/price';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

describe('fabrication zip carries every feature', () => {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', anchorHoles: '0', plateCount: '12', rodsOn: true, rodCount: '2', rodSize: 'M6', spacerMode: 'both' };
  p.appearance = { buckets: [{ id: 'b1', name: 'Fins', material: 'aluminium' }], assign: { P0: 'b1', P11: 'b1' } };
  p.variants = [{ id: 'v1', name: 'A', params: { ...p.params }, locks: {}, pour: p.pour, images: {}, createdAt: '' }];
  const model = createPipeline()(p, assets);
  const files = unzipSync(buildZip(model, p, { ...DEFAULT_RATES, hardware: { rodPerM: 10, nut: 1, washer: 1 } }));
  const names = Object.keys(files);
  const text = (n: string) => strFromU8(files[n]);

  it('splits laser parts and sheets into a folder per metal', () => {
    expect(names.some((n) => n.startsWith('laser/parts/aluminium/'))).toBe(true);
    expect(names.some((n) => n.startsWith('laser/parts/corten/'))).toBe(true);
    expect(names.some((n) => n.startsWith('laser/sheets/aluminium/sheet-01'))).toBe(true);
    expect(names.some((n) => n.startsWith('laser/sheets/corten/sheet-01'))).toBe(true);
    const laser = names.filter((n) => n.startsWith('laser/parts/'));
    expect(laser.length).toBe(model.sliced.parts.length);
  });

  it('includes the bracing spacers, templates and hardware list', () => {
    const fams = new Set(model.sliced.parts.map((q) => q.family));
    expect(fams.has('C')).toBe(true);
    expect(fams.has('T')).toBe(true);
    for (const q of model.sliced.parts.filter((x) => x.family === 'C' || x.family === 'T'))
      expect(names.some((n) => n.startsWith('laser/parts/') && n.endsWith(`/${safe(q.id)}.dxf`))).toBe(true);
    expect(text('hardware.csv')).toMatch(/Threaded rod/);
    expect(text('hardware.csv')).toMatch(/Hex nut/);
  });

  it('has the pour plan, the price estimate with hardware, and the project', () => {
    expect(text('pour-plan.txt')).toMatch(/Bottom band/);
    const price = text('price-estimate.txt');
    expect(price).toMatch(/Aluminium S-/);
    expect(price).toMatch(/Delivery is not included/);
    expect(price).toMatch(/Threaded rod/);
    expect(price).toMatch(/Nuts and washers/);
    expect(price).toMatch(/Total/);
    const back = deserialize(text('project.strata.json'));
    expect(back.appearance?.assign).toEqual(p.appearance!.assign);
    expect(back.variants[0].name).toBe('A');
    expect(names).toContain('model.stl');
    expect(names).toContain('cutlist.csv');
    expect(names.some((n) => n.startsWith('mould/dxf/'))).toBe(true);
  });
});
