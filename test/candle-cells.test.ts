// Candelabra › Snap › Centre in the cells: each candle moves to the middle of the
// bay between the two plates either side of it, and across them to the middle of
// the shelf it stands over or between two waffle cross plates, one candle a cell.
import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject, type Project } from '../src/core/project';
import { DEFAULT_CANDLES, snapToCells } from '../src/core/candles';
import type { ShelfPlate } from '../src/core/shelfPlates';
import type { CutObject } from '../src/core/objects';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const shelf: ShelfPlate = { id: 'hs1', name: 'Shelf 1', x: 0, y: 120, z: 6, len: 240, depth: 60, thick: 0, round: 6, fit: 0.3, on: true };
const project = (params: Record<string, string> = {}, extra: Partial<Project> = {}): Project => {
  const p = newProject();
  return { ...p, params: { ...p.params, insShape: 'none', strataOn: false, stackHeight: '200', ...params } as Project['params'], candles: { ...DEFAULT_CANDLES, snap: 'cells', size: 200, bend: 40 }, ...extra };
};
const candlesOf = (m: ReturnType<ReturnType<typeof createPipeline>>) => m.objects.filter((b) => /^candle\d+$/.test(b.object.id)).map((b) => b.object);
const plateOffsets = (m: ReturnType<ReturnType<typeof createPipeline>>, family: string) => {
  const ps = m.sliced.plates.filter((p) => p.def.family === family).map((p) => p.def.plane);
  const n = ps[0].normal;
  return { n, offs: [...new Set(ps.map((p) => p.origin[0] * n[0] + p.origin[2] * n[2]))].sort((a, b) => a - b) };
};
// the bay (pair of neighbouring plates) a position falls in, and how far from its middle
const bayOf = (offs: number[], s: number) => {
  const i = offs.findIndex((o, k) => k < offs.length - 1 && s >= o && s <= offs[k + 1]);
  return { i, off: i < 0 ? Infinity : Math.abs(s - (offs[i] + offs[i + 1]) / 2) };
};

describe('candles centred in the cells', () => {
  it('on a shelf: middle of each bay along the stack, middle of the shelf across, one candle a bay', () => {
    const m = createPipeline()(project({}, { shelves: [shelf] }), assets);
    const { n, offs } = plateOffsets(m, 'P');
    const cs = candlesOf(m);
    expect(cs.length).toBe(9);
    const bays = cs.map((c) => bayOf(offs, c.x * n[0] + c.z * n[2]));
    for (const b of bays) expect(b.off).toBeLessThan(1e-6);
    expect(new Set(bays.map((b) => b.i)).size).toBe(cs.length);
    // across the plates: the shelf's centre line
    for (const c of cs) expect(c.x * -n[2] + c.z * n[0]).toBeCloseTo(shelf.x * -n[2] + shelf.z * n[0], 6);
  });

  it('on a waffle: middle of each cell between plates and cross plates', () => {
    const m = createPipeline()(project({ sliceMode: 'waffle', waffleLayout: 'grid' }), assets);
    const P = plateOffsets(m, 'P');
    const X = plateOffsets(m, 'X');
    const cs = candlesOf(m);
    const cells = cs.map((c) => {
      const a = bayOf(P.offs, c.x * P.n[0] + c.z * P.n[2]);
      const b = bayOf(X.offs, c.x * X.n[0] + c.z * X.n[2]);
      expect(a.off).toBeLessThan(1e-6);
      expect(b.off).toBeLessThan(1e-6);
      return `${a.i},${b.i}`;
    });
    expect(new Set(cells).size).toBe(cs.length);
  });

  it('on a wall with the plates hanging down, centres along the wall and leaves the drop to the plates', () => {
    const m = createPipeline()(project({ mount: 'wall', wallPlates: 'down' }, { shelves: [] }), assets);
    const { n, offs } = plateOffsets(m, 'P');
    for (const c of candlesOf(m)) expect(bayOf(offs, c.x * n[0] + c.z * n[2]).off).toBeLessThan(1e-6);
  });

  it('moves a candle with its holder parts and leaves up a wall alone', () => {
    const cyl = (id: string, x: number, z: number): CutObject => ({ id, name: id, kind: 'cylinder', w: 10, h: 10, d: 10, x, y: 0, z, rx: 0, ry: 0, rz: 0, clearance: 0, on: true });
    const planes = [0, 20, 40].map((o) => ({ origin: [o, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number] }));
    const out = snapToCells([cyl('candle1', 3, 5), cyl('well1', 3, 5), cyl('candle2', 8, -5)], planes, [], []);
    // candle2 is nearer the first bay's middle, so it takes it and candle1 (with its well) moves on to the next
    expect(out.map((o) => o.x)).toEqual([30, 30, 10]);
    expect(out.map((o) => o.z)).toEqual([5, 5, -5]);
    // up the wall along the stack: nothing to centre
    expect(snapToCells([cyl('candle1', 3, 5)], planes, [], [], [1, 0, 0])[0].x).toBe(3);
  });
});
