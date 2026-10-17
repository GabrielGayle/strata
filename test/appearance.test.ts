import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, serialize, type Project } from '../src/core/project';
import { applyFill, assignPlates, cleanAppearance, defaultAppearance, materialKey, pickPlates, removeBucket, runBetween, type FillPlate } from '../src/core/appearance';
import { buildZip } from '../src/core/exporters';
import { estimateMix, estimatePrice } from '../src/core/price';
import { cutListCsv } from '../src/core/bom';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const plates = (n: number): FillPlate[] => Array.from({ length: n }, (_, i) => ({ key: `P${i + 1}`, height: i === 4 ? 100 : 10 + i }));

describe('quick fills', () => {
  it('picks patterns in stack order', () => {
    const ps = plates(12);
    expect(pickPlates(ps, 'nth', { n: 2 })).toEqual(['P1', 'P3', 'P5', 'P7', 'P9', 'P11']);
    expect(pickPlates(ps, 'nth', { n: 3, offset: 1 })).toEqual(['P2', 'P5', 'P8', 'P11']);
    expect(pickPlates(ps, 'firstHalf')).toHaveLength(6);
    expect(pickPlates(ps, 'secondHalf')[0]).toBe('P7');
    expect(pickPlates(ps, 'middle')).toEqual(['P5', 'P6', 'P7', 'P8']);
    expect(pickPlates(ps, 'ends')).toEqual(['P1', 'P2', 'P11', 'P12']);
    expect(pickPlates(ps, 'tallest')).toContain('P5');
    expect(pickPlates(ps, 'shortest')).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(pickPlates(ps, 'random', { seed: 3 })).toHaveLength(4);
    expect(pickPlates(ps, 'all')).toHaveLength(12);
  });

  it('a new fill replaces the last one instead of piling up', () => {
    const ps = plates(8);
    let app = defaultAppearance();
    app = applyFill(app, ps, 'b1', pickPlates(ps, 'nth', { n: 2 }));
    expect(Object.keys(app.assign)).toEqual(['P1', 'P3', 'P5', 'P7']);
    app = applyFill(app, ps, 'b1', pickPlates(ps, 'ends'));
    expect(Object.keys(app.assign).sort()).toEqual(['P1', 'P8']);
    // other buckets and plates outside the group are left alone
    app = assignPlates({ ...app, buckets: [...app.buckets, { id: 'b2', name: 'Mild', material: 'steel' }] }, ['P4', 'X1'], 'b2');
    app = applyFill(app, ps, 'b1', ['P2']);
    expect(app.assign).toEqual({ P2: 'b1', P4: 'b2', X1: 'b2' });
    expect(removeBucket(app, 'b2').assign).toEqual({ P2: 'b1' });
  });

  it('shift-click runs cover both ends in either direction', () => {
    const order = ['P1', 'P2', 'P3', 'P4', 'P5'];
    expect(runBetween(order, 'P4', 'P2')).toEqual(['P2', 'P3', 'P4']);
    expect(runBetween(order, 'P1', 'nope')).toEqual(['nope']);
  });
});

describe('mixed metals through the pipeline', () => {
  const slimProject = (): Project => {
    const p = newProject();
    p.params = { ...p.params, plateCount: '6', insShape: 'none' };
    return p;
  };
  const mixed = (base: Project = slimProject()): Project => {
    const app = defaultAppearance();
    return { ...base, appearance: assignPlates(app, ['P1', 'P3', 'P5'], 'b1') };
  };

  it('cuts each metal on its own sheets and weighs it by its own density', () => {
    const plain = createPipeline()(slimProject(), assets);
    const m = createPipeline()(mixed(), assets);
    expect(m.bom.byMaterial.map((g) => g.material)).toEqual(['corten', 'aluminium']);
    const alu = m.bom.rows.filter((r) => r.material === 'aluminium');
    expect(alu.length).toBeGreaterThan(0);
    expect(m.bom.plateMass).toBeLessThan(plain.bom.plateMass);
    for (const s of m.nested.sheets) {
      const metals = new Set(s.placements.map((p) => m.bom.rows.find((r) => r.id === p.id)!.material));
      expect([...metals]).toEqual([s.material]);
    }
    expect(m.nested.sheets.map((s) => s.index)).toEqual(m.nested.sheets.map((_, i) => i));
    expect(m.nested.unplaced).toEqual([]);
    expect(cutListCsv(m.v, m.bom)).toContain('Aluminium,3,Aluminium');
  });

  it('puts each metal in its own folder in the ZIP', () => {
    const small = newProject();
    small.params = { ...small.params, plateCount: '8', insShape: 'none', anchorHoles: '0' };
    const p = mixed(small);
    const m = createPipeline()(p, assets);
    const files = Object.keys(unzipSync(buildZip(m, p)));
    expect(files.some((f) => f.startsWith('laser/parts/aluminium/'))).toBe(true);
    expect(files.some((f) => f.startsWith('laser/parts/corten/'))).toBe(true);
    expect(files).toContain('laser/sheets/aluminium/sheet-01-cut.dxf');
    expect(files).toContain('laser/sheets/corten/sheet-01-cut.dxf');
    // one metal keeps the old flat layout
    const plainP = slimProject();
    const plain = createPipeline()(plainP, assets);
    expect(Object.keys(unzipSync(buildZip(plain, plainP)))).toContain('laser/sheets/sheet-01-cut.dxf');
  });

  it('prices each metal on its own rates with one order minimum', () => {
    const m = createPipeline()(mixed(), assets);
    const e = estimateMix(m.bom, m.v.thickness);
    expect(e.fitted).toBe(true);
    expect(e.lines.some((l) => l.label.startsWith('Aluminium'))).toBe(true);
    expect(e.lines.some((l) => l.label.startsWith('Corten'))).toBe(true);
    expect(e.lines.filter((l) => l.label === 'Minimum order charge')).toHaveLength(e.subtotal < 55 - 1e-9 ? 1 : 0);
    // a single metal prices exactly as before
    const plain = createPipeline()(slimProject(), assets);
    expect(estimateMix(plain.bom, 3).total).toBeCloseTo(estimatePrice(plain.bom, 'corten', 3).total, 9);
  });

  it('tunes aluminium plates to their own length', () => {
    const tuned = newProject();
    tuned.params = { ...tuned.params, insShape: 'none', tuneMode: 'notes', tuneNotes: 'A3', plateCount: '4' };
    const steel = createPipeline()(tuned, assets);
    const p = { ...tuned, appearance: assignPlates(defaultAppearance(), ['P1'], 'b1') };
    const m = createPipeline()(p, assets);
    const t = m.sliced.tuning!.filter(Boolean);
    expect(t[1]!.material).toBe('aluminium');
    expect(t[0]!.cut).toBeCloseTo(steel.sliced.tuning!.filter(Boolean)[0]!.cut, 6);
    // aluminium's bending speed is near steel's, so the length differs only a little, but it does differ
    expect(Math.abs(t[1]!.cut - t[0]!.cut)).toBeGreaterThan(0.01);
  });

  it('only re-slices for a metal change when the plates are tuned', () => {
    const pipe = createPipeline();
    const a = pipe(slimProject(), assets);
    const b = pipe(mixed(), assets);
    expect(b.sliced).toBe(a.sliced);
    expect(materialKey(mixed().appearance, 'corten')).toContain('P1=aluminium');
  });

  it('round-trips through the project file and drops bad entries', () => {
    const p = mixed();
    const back = deserialize(serialize(p));
    expect(back.appearance).toEqual(p.appearance);
    expect(cleanAppearance({ buckets: [{ id: 'b1', name: 'x', material: 'gold' }], assign: { P1: 'b1', P2: 'gone' } })).toEqual({
      buckets: [{ id: 'b1', name: 'x', material: 'steel' }],
      assign: { P1: 'b1' },
    });
    expect(cleanAppearance(null)).toBeUndefined();
  });
});
