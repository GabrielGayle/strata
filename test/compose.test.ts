import { describe, expect, it } from 'vitest';
import { composite, makeBlock, moveBlock, newComposition, newDrawing, renderDrawing, restack, swapSurfaces, type Composition } from '../src/core/compose';
import type { Gray } from '../src/core/image';
import { createPipeline } from '../src/core/pipeline';
import { deserialize, newProject, serialize } from '../src/core/project';
import { topAt } from '../src/core/slicer';

const solid = (v: number, w = 4, h = 4): Gray => ({ w, h, data: new Float32Array(w * h).fill(v) });
const at = (g: Gray, fx: number, fy: number) => g.data[Math.min(g.h - 1, Math.floor(fy * g.h)) * g.w + Math.min(g.w - 1, Math.floor(fx * g.w))];
const img = (name = 'a.png') => ({ kind: 'image' as const, name, dataUrl: 'data:' + name });

describe('composer', () => {
  it('places a block where it is put and leaves the rest of the frame white', () => {
    const c = newComposition({ top: 1 });
    c.blocks.push(makeBlock(img(), { x: 0.25, y: 0.25, scale: 0.3 }));
    const g = composite(c, 'top', () => solid(0), 100, 100);
    expect(at(g, 0.25, 0.25)).toBe(0);
    expect(at(g, 0.75, 0.75)).toBe(1);
    expect(at(g, 0.45, 0.25)).toBe(1); // half width 0.15 ends at 0.40
  });

  it('only renders blocks on the surface asked for, and skips hidden ones', () => {
    const c = newComposition();
    c.blocks.push(makeBlock(img(), { surface: 'front', scale: 1 }), makeBlock(img(), { surface: 'top', hidden: true, scale: 1 }));
    expect(at(composite(c, 'top', () => solid(0), 30, 20), 0.5, 0.5)).toBe(1);
    expect(at(composite(c, 'front', () => solid(0), 30, 20), 0.5, 0.5)).toBe(0);
  });

  it('keeps a square source square on a wide frame, and rotation turns it', () => {
    const c = newComposition({ top: 2 });
    const b = makeBlock(img(), { scale: 0.25 }); // 50 px wide on a 200 x 100 frame
    c.blocks.push(b);
    const g = composite(c, 'top', () => solid(0), 200, 100);
    expect(at(g, 0.5, 0.5 + 0.2)).toBe(0); // 50 px tall: reaches 25 px below centre
    expect(at(g, 0.5, 0.5 + 0.3)).toBe(1);
    // a 2:1 source rotated 90 degrees stands upright
    const wide = { w: 8, h: 4, data: new Float32Array(32) };
    const r = newComposition({ top: 1 });
    r.blocks.push(makeBlock(img(), { scale: 0.6, rotate: 90 }));
    const gr = composite(r, 'top', () => wide, 100, 100);
    expect(at(gr, 0.5, 0.22)).toBe(0);
    expect(at(gr, 0.22, 0.5)).toBe(1);
  });

  it('blends: darken keeps the darker, lighten the lighter, normal covers, opacity mixes', () => {
    const two = (blend: any, opacity = 1): Composition => {
      const c = newComposition({ top: 1 });
      c.blocks.push(makeBlock(img('dark'), { scale: 1 }), makeBlock(img('light'), { scale: 1, blend, opacity }));
      return c;
    };
    const src = (b: any) => (b.source.name === 'dark' ? solid(0.2) : solid(0.6));
    expect(at(composite(two('darken'), 'top', src, 10, 10), 0.5, 0.5)).toBeCloseTo(0.2);
    expect(at(composite(two('lighten'), 'top', src, 10, 10), 0.5, 0.5)).toBeCloseTo(0.6);
    expect(at(composite(two('normal'), 'top', src, 10, 10), 0.5, 0.5)).toBeCloseTo(0.6);
    expect(at(composite(two('multiply'), 'top', src, 10, 10), 0.5, 0.5)).toBeCloseTo(0.12);
    expect(at(composite(two('normal', 0.5), 'top', src, 10, 10), 0.5, 0.5)).toBeCloseTo(0.4);
  });

  it('moves, restacks and swaps blocks between surfaces', () => {
    let c = newComposition({ top: 1, front: 3 });
    const a = makeBlock(img('a'));
    const b = makeBlock(img('b'));
    const f = makeBlock(img('f'), { surface: 'front' });
    c.blocks.push(a, b, f);
    c = restack(c, a.id, 1);
    expect(c.blocks.filter((x) => x.surface === 'top').map((x) => x.name)).toEqual(['b', 'a']);
    c = moveBlock(c, b.id, 'side');
    expect(c.blocks.find((x) => x.id === b.id)!.surface).toBe('side');
    c = swapSurfaces(c, 'top', 'front');
    expect(c.blocks.find((x) => x.id === a.id)!.surface).toBe('front');
    expect(c.blocks.find((x) => x.id === f.id)!.surface).toBe('top');
    expect(c.frames.top.aspect).toBe(3);
    c = moveBlock(c, f.id, null);
    expect(c.blocks.find((x) => x.id === f.id)!.surface).toBeNull();
  });

  it('draws round strokes, and a white stroke erases', () => {
    const d = newDrawing(1);
    d.strokes.push({ pts: [0.2, 0.5, 0.8, 0.5], size: 0.1, tone: 0, soft: 0 });
    let g = renderDrawing(d, 100, 100);
    expect(at(g, 0.5, 0.5)).toBe(0);
    expect(at(g, 0.5, 0.6)).toBe(1);
    expect(at(g, 0.1, 0.5)).toBe(1);
    d.strokes.push({ pts: [0.5, 0.5], size: 0.2, tone: 1, soft: 0 });
    g = renderDrawing(d, 100, 100);
    expect(at(g, 0.5, 0.5)).toBe(1);
    expect(at(g, 0.3, 0.5)).toBe(0);
  });

  it('survives a project save and load', () => {
    const p = newProject();
    const c = newComposition();
    c.blocks.push(makeBlock({ kind: 'drawing', spec: newDrawing() }));
    const back = deserialize(serialize({ ...p, composition: c }));
    expect(back.composition?.blocks[0].source.kind).toBe('drawing');
    expect(deserialize(serialize(p)).composition).toBeUndefined();
  });

  it('a composite presses into the plate tops like any image', () => {
    const c = newComposition({ top: 2 });
    c.blocks.push(makeBlock(img(), { x: 0.5, y: 0.5, scale: 0.3 }));
    const topImg = composite(c, 'top', () => solid(0), 120, 60);
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgTopMode: 'carve', topDepth: '20', topSteps: '1', imgSmooth: '0', imgContrast: '1' };
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg, insMesh: null, srcMesh: null });
    const plates = m.sliced.plates;
    const mid = plates[Math.floor(plates.length / 2)].parts[0];
    expect(topAt(mid.shape, 0)).toBeCloseTo(m.v.stackHeight - 20, 1);
    expect(topAt(plates[0].parts[0].shape, 0)).toBeCloseTo(m.v.stackHeight, 1);
  });
});
