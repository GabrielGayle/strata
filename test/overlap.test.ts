import { describe, expect, it } from 'vitest';
import { bboxOf, intersection, rect, shapeArea, type Shape } from '../src/core/geom2d';
import { finishPlatePieces } from '../src/core/fragments';
import type { Values } from '../src/core/params';
import { createFrontPipeline, createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS, type Project } from '../src/core/project';
import { DEFAULT_CANDLES, finSlots, type CandleSpec } from '../src/core/candles';
import { findOverlaps, footprintBox, overlapRegion } from '../src/core/overlap';
import type { Plane } from '../src/core/section';
import type { Part } from '../src/core/slicer';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

/** An upright plane through (x, z) whose face points along `deg` in plan. */
function upright(x: number, z: number, deg: number): Plane {
  const a = (deg * Math.PI) / 180;
  const n: [number, number, number] = [Math.cos(a), 0, Math.sin(a)];
  return { origin: [x, 0, z], normal: n, u: [n[2], 0, -n[0]], v: [0, 1, 0] };
}

function part(id: string, plane: Plane, shape: Shape, thickness = 3): Part {
  return { id, plateKey: id, family: 'P', index: 0, piece: 0, plane, thickness, shape, etch: [], labelPaths: [], labelAt: null, area: shapeArea(shape), perimeter: 0, bbox: bboxOf(shape.map((e) => e.outer)), anchored: true, kind: 'plate' };
}

function preset(name: string, params: Record<string, string | boolean> = {}, candles?: Partial<CandleSpec>): Project {
  const p = applyPreset(newProject(), PRESETS.find((q) => q.name === name)!);
  return { ...p, params: { ...p.params, ...params }, ...(candles ? { candles: { ...DEFAULT_CANDLES, ...candles } } : {}) };
}

const overlapsOf = (p: Project) => findOverlaps(createFrontPipeline({})(p, assets).sliced.parts);

describe('metal overlap check', () => {
  it('finds side-by-side plates closer than their thickness, not ones that only touch', () => {
    const a = part('A', upright(0, 0, 0), rect(-50, 0, 50, 100));
    expect(findOverlaps([a, part('B', upright(2, 0, 0), rect(-50, 0, 50, 100))])).toHaveLength(1);
    expect(findOverlaps([a, part('B', upright(3, 0, 0), rect(-50, 0, 50, 100))])).toHaveLength(0);
    // close, but the outlines don't meet
    expect(findOverlaps([a, part('B', upright(1, 0, 0), rect(60, 0, 100, 100))])).toHaveLength(0);
  });

  it('finds a square crossing with no slots, and clears one with half laps', () => {
    const a = part('A', upright(0, 0, 0), rect(-50, 0, 50, 100));
    const b = part('B', upright(0, 0, 90), rect(-50, 0, 50, 100));
    const hit = findOverlaps([a, b]);
    expect(hit).toHaveLength(1);
    // 3 mm of the other plate's steel across the whole 100 mm height
    expect(hit[0].area).toBeGreaterThan(250);
    const slotA = part('A', a.plane, [{ outer: [[-50, 0], [50, 0], [50, 100], [1.6, 100], [1.6, 50], [-1.6, 50], [-1.6, 100], [-50, 100]], holes: [] }]);
    const slotB = part('B', b.plane, [{ outer: [[-50, 0], [-1.6, 0], [-1.6, 50], [1.6, 50], [1.6, 0], [50, 0], [50, 100], [-50, 100]], holes: [] }]);
    expect(findOverlaps([slotA, slotB])).toHaveLength(0);
  });

  it('finds a slanted crossing whose slot ignores the drift through the plate', () => {
    // at 45° the other plate covers t / sin 45° on the mid-plane, plus t × cot 45° across this plate's thickness
    const a = part('A', upright(0, 0, 0), [{ outer: [[-50, 0], [50, 0], [50, 100], [2.2, 100], [2.2, 50], [-2.2, 50], [-2.2, 100], [-50, 100]], holes: [] }]);
    const b = part('B', upright(0, 0, 45), [{ outer: [[-50, 0], [-2.2, 0], [-2.2, 50], [2.2, 50], [2.2, 0], [50, 0], [50, 100], [-50, 100]], holes: [] }]);
    expect(findOverlaps([a, b]).length).toBeGreaterThan(0);
    const room = footprintBox(a, b)!;
    // 3 / sin 45° + 3 × cot 45° = 7.24 mm along a
    expect(room.maxX - room.minX).toBeCloseTo(3 / Math.SQRT1_2 + 3, 1);
  });

  it('gives the same overlap however the pair is asked', () => {
    const a = part('A', upright(0, 0, 0), rect(-50, 0, 50, 100));
    const b = part('B', upright(0, 0, 30), rect(-50, 0, 50, 100));
    expect(shapeArea(overlapRegion(a, b))).toBeGreaterThan(0);
    expect(shapeArea(overlapRegion(b, a))).toBeGreaterThan(0);
  });

  it('is clean on every preset', () => {
    for (const pr of PRESETS) expect(overlapsOf(applyPreset(newProject(), pr)).map((h) => `${pr.name}: ${h.a.id} × ${h.b.id}`)).toEqual([]);
  });

  it('is clean on steel bases, bracing, support rings and slanted waffles', () => {
    const cases: [string, Record<string, string | boolean>][] = [
      ['Mini Vermilion', { baseMaterial: 'steel', steelHoles: 'rows', steelHoleStyle: 'keyhole', steelStagger: false }],
      ['Mini waffle', { baseMaterial: 'steel' }],
      ['Mini Vermilion', { baseMaterial: 'steel', steelZigzag: true }],
      ['Mini radial', { baseMaterial: 'steel' }],
      ['Mini radial', { supportMode: 'radial' }],
      ['Vermilion 40', { supportMode: 'radial' }],
      ['Mini Vermilion', { bracingOn: true, rodsOn: true, spacerMode: 'both', crossAngle: '30' }],
      ['Waffle field', { gridAngle: '135' }],
      ['Waffle field', { waffleLayout: 'grid', gridAngle: '60', baseMaterial: 'steel' }],
    ];
    for (const [n, params] of cases) expect(overlapsOf(preset(n, params)).map((h) => `${n} ${JSON.stringify(params)}: ${h.a.id} × ${h.b.id}`)).toEqual([]);
  });

  it('leaves room in the plates for every candle fin', () => {
    const cases: Partial<CandleSpec>[] = [
      { holder: 'target', fins: 4, spin: 30 },
      { holder: 'target', fins: 3, spin: 0 },
      { holder: 'target', fins: 6, spin: 45, sit: 'surface' },
      { holder: 'slotted', fins: 3, spin: 45 },
      { holder: 'slotted', fins: 6, spin: 60, sit: 'surface' },
      { holder: 'target', finJoin: 'cross' },
    ];
    for (const c of cases) expect(overlapsOf(preset('Vermilion 40', {}, c)).map((h) => `${JSON.stringify(c)}: ${h.a.id} × ${h.b.id}`)).toEqual([]);
  });

  it('cuts slanted fin slots wide enough for the plate thickness too', () => {
    const fin = { holder: 0, fin: 0, plane: upright(0, 0, 45), shape: rect(-20, 0, 20, 30), labelAt: [0, 0] as [number, number], labelMax: 1 };
    const [s] = finSlots(fin, [{ key: 'P0', plane: upright(0, 0, 0), u0: -100, u1: 100 }], { t: 3, candleBottom: 20, baseTop: 0, engage: 16, fit: 0 });
    expect(s.plateRect[2] - s.plateRect[0]).toBeCloseTo(3 / Math.SQRT1_2 + 3, 5);
  });

  it('reports overlaps as fit-check errors', () => {
    const m = createPipeline()(preset('Mini Vermilion', { pitch: '1' }), assets);
    expect(m.issues.some((i) => i.type === 'collision' && i.severity === 'error' && /overlap/.test(i.message))).toBe(true);
  });
});

describe('thin neck repair', () => {
  it('does not grow back into a slot left for another part', () => {
    const v = { minFeature: 3, minFragment: 3, kerf: 0.2, fragmentMode: 'auto', minPartSize: 15, thickness: 1.5 } as unknown as Values;
    // a 1 mm web beside a 4 mm slot: widening the web grows it into the slot
    const slot = rect(10, 20, 14, 200);
    const shape = [{ outer: [[0, 0], [30, 0], [30, 20], [15, 20], [15, 50], [14, 50], [14, 20], [10, 20], [10, 50], [0, 50]] as [number, number][], holes: [] }];
    const free = finishPlatePieces(shape, { v, plateKey: 'P0', plateId: 'S-01', anchored: () => true });
    const kept = finishPlatePieces(shape, { v, plateKey: 'P0', plateId: 'S-01', anchored: () => true, keepOut: slot });
    const inSlot = (s: Shape) => s.reduce((a, ex) => a + shapeArea(intersection([ex], slot)), 0);
    expect(inSlot(free.pieces)).toBeGreaterThan(0.5);
    expect(inSlot(kept.pieces)).toBeLessThan(0.01);
  });
});
