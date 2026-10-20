import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, serialize, type Project } from '../src/core/project';
import { runChecks } from '../src/core/checks';
import { cleanShelfPlates, newShelf, shelfOutline, type ShelfPlate } from '../src/core/shelfPlates';
import { cleanPlacedCandles, type PlacedCandle } from '../src/core/surfaceCandles';
import { DEFAULT_CANDLES as DEFAULT, finSlots, targetFins } from '../src/core/candles';
import { shapeArea } from '../src/core/geom2d';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
// plain flat-topped plates, so every slot shows as its own hole
const plain = (extra: Partial<Project> = {}): Project => {
  const p = newProject();
  return { ...p, params: { ...p.params, insShape: 'none', strataOn: false, stackHeight: '200' } as Project['params'], ...extra };
};
const shelf = (over: Partial<ShelfPlate> = {}): ShelfPlate => ({ id: 'hs1', name: 'Shelf 1', x: 0, y: 260, z: 0, len: 160, depth: 100, thick: 0, round: 6, fit: 0.3, on: true, ...over });
const build = (extra: Partial<Project>) => createPipeline()(plain(extra), assets);
const holesAt = (m: ReturnType<typeof build>, y: number) =>
  m.sliced.parts.filter((p) => p.family === 'P' && p.shape[0].holes.some((h) => Math.min(...h.map((q) => q[1])) < y && Math.max(...h.map((q) => q[1])) > y));

describe('shelves', () => {
  it('slots every plate it crosses and adds a shelf part the size asked for', () => {
    const m = build({ shelves: [shelf()] });
    const parts = m.sliced.parts.filter((p) => p.family === 'H');
    expect(parts.length).toBe(1);
    expect(parts[0].thickness).toBe(m.v.thickness);
    // 160 × 100 with 6 mm corners
    expect(parts[0].area).toBeCloseTo(160 * 100 - (4 - Math.PI) * 36, -1);
    // its top at 260: plate coordinates are from the base top
    expect(parts[0].plane.origin[1] + parts[0].thickness / 2).toBeCloseTo(260, 5);
    const slotY = 260 - m.v.baseHeight - m.v.thickness / 2;
    const slotted = holesAt(m, slotY);
    const across = m.sliced.plates.filter((pl) => Math.abs(pl.def.plane.origin[0]) <= 80 + m.v.thickness / 2);
    expect(slotted.length).toBe(across.length);
    expect(slotted.length).toBeGreaterThan(5);
    // each slot is the shelf's depth and thickness plus the fit
    const h = slotted[0].shape[0].holes.find((q) => Math.min(...q.map((p) => p[1])) < slotY)!;
    const ys = h.map((q) => q[1]);
    const us = h.map((q) => q[0]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(m.v.thickness + 0.6, 1);
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(100 + 0.6, 1);
    expect(m.sliced.warnings).toEqual([]);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
  });

  it('warns when the shelf cuts a plate in two', () => {
    const m = build({ shelves: [shelf({ depth: 400 })] });
    expect(m.sliced.warnings.some((w) => w.includes('Shelf 1 cuts') && w.includes('in two'))).toBe(true);
  });

  it('a shelf that is off or on a flat stack cuts nothing', () => {
    expect(build({ shelves: [shelf({ on: false })] }).sliced.parts.some((p) => p.family === 'H')).toBe(false);
    const p = plain({ shelves: [shelf()] });
    const flat = createPipeline()({ ...p, params: { ...p.params, sliceMode: 'flat' } }, assets);
    expect(flat.sliced.parts.some((q) => q.family === 'H')).toBe(false);
  });

  it('survives a save and load, dropping broken entries', () => {
    const p = plain({ shelves: [shelf()], placedCandles: [{ id: 'pc1', size: 'taper', on: 'shelf', shelf: 'hs1', x: 5, z: -5 }] });
    const back = deserialize(serialize(p));
    expect(back.shelves).toEqual([shelf()]);
    expect(back.placedCandles).toEqual([{ id: 'pc1', size: 'taper', on: 'shelf', shelf: 'hs1', x: 5, z: -5 }]);
    expect(cleanShelfPlates([null, { id: 'a', len: -5 }])).toEqual([expect.objectContaining({ id: 'a', len: 10 })]);
    expect(cleanPlacedCandles([{ on: 'wall' }])).toEqual([expect.objectContaining({ on: 'base', size: 'taper' })]);
    expect(newShelf([shelf()], { x: 1.4, y: 99.6, z: 0 })).toMatchObject({ id: 'hs2', x: 1, y: 100 });
    expect(shapeArea(shelfOutline({ id: 'x', name: 'x', x: 0, z: 0, top: 0, t: 3, sx: 50, sz: 20, round: 0 }))).toBeCloseTo(1000, 3);
  });
});

describe('candles placed on surfaces', () => {
  const on = (c: Omit<PlacedCandle, 'id'>[], extra: Partial<Project> = {}) => build({ placedCandles: c.map((x, i) => ({ ...x, id: `pc${i + 1}` })), ...extra });

  it('on a shelf: fins stand on it and drop tabs into slots cut in it', () => {
    const m = on([{ size: 'taper', on: 'shelf', shelf: 'hs1', x: 0, z: 0 }], { shelves: [shelf()] });
    const candle = m.objects.find((o) => o.object.id === 'pc1')!.object;
    expect(candle.y - candle.h / 2).toBeCloseTo(260, 5);
    const fins = m.sliced.parts.filter((p) => p.family === 'K');
    expect(fins.length).toBe(4);
    // each fin reaches below the shelf top by the shelf thickness (its tab), no further
    for (const f of fins) expect(f.plane.origin[1] + f.bbox.minY).toBeCloseTo(260 - m.v.thickness, 5);
    const sh = m.sliced.parts.find((p) => p.family === 'H')!;
    expect(sh.shape[0].holes.length).toBe(4);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
    expect(m.lostCandles).toBeUndefined();
  });

  it('a shelf candle moves with its shelf, and is left out when it falls off it', () => {
    const m = on([{ size: 'taper', on: 'shelf', shelf: 'hs1', x: 10, z: 0 }], { shelves: [shelf({ x: 100, y: 250 })] });
    const c = m.objects.find((o) => o.object.id === 'pc1')!.object;
    expect([c.x, c.y - c.h / 2]).toEqual([110, 250]);
    const off = on([{ size: 'taper', on: 'shelf', shelf: 'hs1', x: 200, z: 0 }], { shelves: [shelf()] });
    expect(off.lostCandles).toEqual(['pc1']);
    expect(off.sliced.parts.some((p) => p.family === 'K')).toBe(false);
  });

  it('on the plate tops: sinks in by its grip and slots its fins onto the plates without overlapping them', () => {
    const m = on([{ size: 'tealight', on: 'plates', x: 150, z: 0 }]);
    const c = m.objects.find((o) => o.object.id === 'pc1')!.object;
    const top = m.v.baseHeight + 200;
    expect(c.y - c.h / 2).toBeCloseTo(top - Math.min(10, c.h - 1), 0);
    expect(m.sliced.parts.filter((p) => p.family === 'K').length).toBe(4);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
  });

  it('on the concrete: target fins set in it, the plates cleared round them right down into the concrete', () => {
    const m = on([{ size: 'taper', on: 'base', x: 0, z: 0 }]);
    const c = m.objects.find((o) => o.object.id === 'pc1')!.object;
    expect(c.y - c.h / 2).toBeCloseTo(m.v.baseHeight, 5);
    const well = m.objects.find((o) => o.object.id === 'pc1well')!.object;
    expect(well.y - well.h / 2).toBeLessThan(m.v.baseHeight - m.v.embedDepth);
    expect(m.sliced.parts.filter((p) => p.family === 'K').length).toBe(4);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
  });
});

describe('candle fin slots at a slant', () => {
  it('are wide enough for both slabs where a fin crosses a plate at 45°', () => {
    const [fin] = targetFins({ x: 0, z: 0, r: 11, bottom: 100, ry: 0 }, { fins: 4, reach: 18, grip: 28, spin: 45, slotted: true, engage: 16 }, { t: 3, embed: 0, baseTop: 0, slack: 0.8, minFeature: 2 }, 0);
    const plate = { key: 'P1', plane: { origin: [20, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], u: [0, 0, -1] as [number, number, number], v: [0, 1, 0] as [number, number, number] }, u0: -100, u1: 100 };
    const [s] = finSlots(fin, [plate], { t: 3, candleBottom: 100, baseTop: 0, engage: 16, fit: 0.3 });
    // 3 / cos 45 for the fin's own thickness, + 3 · tan 45 as it passes through the plate's
    expect(s.plateRect[2] - s.plateRect[0]).toBeCloseTo(3 * Math.SQRT2 + 3 + 0.3, 5);
  });
});

describe('placed candles with two-piece fins', () => {
  const spec = { finJoin: 'cross' } as const;
  const run = (c: Omit<PlacedCandle, 'id'>, extra: Partial<Project> = {}) => {
    const p = plain({ placedCandles: [{ ...c, id: 'pc1' }], ...extra });
    // the candelabra itself is off: placed candles only borrow its fin settings
    return createPipeline()({ ...p, candles: { ...DEFAULT, ...spec, on: false } }, assets);
  };
  it('on a shelf: two halved pieces on a pedestal, each with a tab under both arms', () => {
    const m = run({ size: 'taper', on: 'shelf', shelf: 'hs1', x: 0, z: 0 }, { shelves: [shelf()] });
    const fins = m.sliced.parts.filter((p) => p.family === 'K');
    expect(fins.length).toBe(2);
    const c = m.objects.find((o) => o.object.id === 'pc1')!.object;
    expect(c.y - c.h / 2).toBeCloseTo(260 + 2 * Math.max(m.v.minFeature, 3), 5);
    expect(m.sliced.parts.find((p) => p.family === 'H')!.shape[0].holes.length).toBe(4);
    for (const f of fins) expect(f.plane.origin[1] + f.bbox.minY).toBeCloseTo(260 - m.v.thickness, 5);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
    expect(m.sliced.warnings).toEqual([]);
  });
  it('on the concrete and the plate tops: two pieces too', () => {
    expect(run({ size: 'taper', on: 'base', x: 0, z: 0 }).sliced.parts.filter((p) => p.family === 'K').length).toBe(2);
    const m = run({ size: 'taper', on: 'plates', x: 150, z: 0 });
    expect(m.sliced.parts.filter((p) => p.family === 'K').length).toBe(2);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
  });
});

describe('slotted fins beside a candle socket', () => {
  it('clear the thin steel between slot and socket instead of the neck repair growing it back into the slot', async () => {
    const { PRESETS, applyPreset } = await import('../src/core/project');
    const p = applyPreset(newProject(), PRESETS.find((x) => x.name.startsWith('Vermilion 40'))!);
    const m = createPipeline()({ ...p, shelves: [shelf({ x: 150, y: 200 })], placedCandles: [{ id: 'pc1', size: 'taper', on: 'plates', x: 150, z: 0 }] }, assets);
    expect(m.sliced.parts.filter((q) => q.family === 'K').length).toBe(4);
    expect(runChecks(m.v, m.sliced).filter((i) => i.type === 'collision')).toEqual([]);
  });
});

describe('shelves on a wall piece', () => {
  it('warn that they stand out from the wall instead of level', () => {
    const p = plain({ shelves: [shelf()] });
    const m = createPipeline()({ ...p, params: { ...p.params, mount: 'wall' } }, assets);
    expect((m.fieldIssues ?? []).some((i) => /Shelves are level on a table piece/.test(i.message))).toBe(true);
    expect((build({ shelves: [shelf()] }).fieldIssues ?? []).some((i) => /Shelves/.test(i.message))).toBe(false);
  });
});
