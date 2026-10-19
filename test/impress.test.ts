import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { composite, makeBlock, newComposition, type Composition } from '../src/core/compose';
import type { Gray } from '../src/core/image';
import { topUV } from '../src/core/slicer';
import { planeToWorld } from '../src/core/section';
import { shapeBBox } from '../src/core/geom2d';
import { blockAt, blockCorners, depthField, fillPatch, framePoint, frameFractions, impressFrames, layerDepth, refitBlocks, setLayerDepth, type ImpressFrame } from '../src/core/impress';

const grey = (w: number, h: number, v = 1): Gray => ({ w, h, data: new Float32Array(w * h).fill(v) });

function run(params: Record<string, string>, imgs: { frontImg?: Gray; topImg?: Gray }) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', ...params };
  return createPipeline()(p, { sideImg: null, frontImg: imgs.frontImg ?? null, topImg: imgs.topImg ?? null, insMesh: null, srcMesh: null });
}

/** Where picture fractions land after Image direction turns the picture r quarter turns clockwise. */
function turned(a: number, b: number, r: number): [number, number] {
  return r === 1 ? [1 - b, a] : r === 2 ? [1 - a, 1 - b] : r === 3 ? [b, 1 - a] : [a, b];
}

describe('impress frames', () => {
  for (const topRotate of ['0', '90', '180', '270'])
    for (const imgRotate of ['0', '90', '270'])
      it(`top: a point placed on the picture is where the slicer reads it (turn ${topRotate}, image ${imgRotate})`, () => {
        const m = run({ imgTopMode: 'carve', topRotate, imgRotate, topScale: '0.8', topX: '12' }, { topImg: grey(120, 60) });
        const f = impressFrames(m.sliced, m.v).top!;
        expect(f.window).toBeTruthy();
        // the frame keeps the picture's own proportions
        expect(f.window!.w / f.window!.h).toBeCloseTo(120 / 60, 3);
        for (const [a, b] of [
          [0.2, 0.3],
          [0.7, 0.9],
        ]) {
          const uv = topUV(m.sliced.top!, framePoint(f.window!, a, b))!;
          const [ea, eb] = turned(a, b, Number(imgRotate) / 90);
          expect(uv[0]).toBeCloseTo(ea, 4);
          expect(uv[1]).toBeCloseTo(eb, 4);
        }
      });

  it('top: the area is the whole surface and equals the window once the picture fills it', () => {
    const m0 = run({ imgTopMode: 'carve' }, { topImg: grey(100, 100) });
    const area = impressFrames(m0.sliced, m0.v).top!.area;
    // full size, as Impress sets it (the default picture size is 0.9)
    const m = run({ imgTopMode: 'carve', topScale: '1' }, { topImg: grey(Math.round(area.w * 2), Math.round(area.h * 2)) });
    const f = impressFrames(m.sliced, m.v).top!;
    expect(f.window!.w).toBeCloseTo(f.area.w, 0);
    expect(f.window!.h).toBeCloseTo(f.area.h, 0);
  });

  it('front: a dark spot placed on the face is cut out of the front plate there', () => {
    const base = run({ imgFrontMode: 'layers' }, { frontImg: grey(100, 100) });
    const area = impressFrames(base.sliced, base.v).front!.area;
    // a picture with the face's proportions, one dark square at (0.25, 0.4)
    let comp: Composition = newComposition({ front: area.w / area.h });
    const dot = grey(20, 20, 0);
    comp = { ...comp, blocks: [makeBlock({ kind: 'image', name: 'dot', dataUrl: 'x' }, { surface: 'front', x: 0.25, y: 0.4, scale: 0.12, blend: 'normal' })] };
    const w = 300, h = Math.round(300 / (area.w / area.h));
    const img = composite(comp, 'front', () => dot, w, h);
    const m = run({ imgFrontMode: 'layers', frontDepth: '3', imgFrontStrength: '1' }, { frontImg: img });
    expect(m.sliced.plates.length).toBe(base.sliced.plates.length);
    const f = impressFrames(m.sliced, m.v).front!.window!;
    const p0 = m.sliced.parts.find((p) => p.family === 'P' && p.index === 0)!;
    const hole = p0.shape.flatMap((e) => e.holes).find((hl) => hl.length > 4)!;
    expect(hole).toBeTruthy();
    const bb = shapeBBox([{ outer: hole, holes: [] }]);
    const c = planeToWorld(p0.plane, (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2);
    const [fx, fy] = frameFractions(f, c);
    expect(fx).toBeCloseTo(0.25, 1);
    expect(fy).toBeCloseTo(0.4, 1);
    // three plates deep, and the fourth is whole
    const holes = (mm: typeof m, i: number) => mm.sliced.parts.filter((p) => p.family === 'P' && p.index === i).flatMap((p) => p.shape.flatMap((e) => e.holes)).length;
    expect(holes(m, 2)).toBeGreaterThan(holes(base, 2));
    expect(holes(m, 3)).toBe(holes(base, 3));
  });
});

describe('impress layers', () => {
  const frame = (w: number, h: number, ox = 0): ImpressFrame => ({ surface: 'top', origin: [ox, 100, 0], ax: [1, 0, 0], ay: [0, 0, 1], w, h, inward: [0, -1, 0] });

  it('refitting to a bigger frame keeps every layer where it was, the same size', () => {
    const from = frame(100, 50, 20);
    const to = frame(200, 120);
    const b = makeBlock({ kind: 'image', name: 'a', dataUrl: 'x' }, { surface: 'top', x: 0.3, y: 0.6, scale: 0.4, rotate: 15 });
    const before = { ...newComposition({ top: 2 }), blocks: [b] };
    const after = refitBlocks(before, 'top', from, to);
    const nb = after.blocks[0];
    const p = framePoint(to, nb.x, nb.y);
    const q = framePoint(from, b.x, b.y);
    expect(p[0]).toBeCloseTo(q[0], 3);
    expect(p[2]).toBeCloseTo(q[2], 3);
    expect(nb.scale * to.w).toBeCloseTo(b.scale * from.w, 3);
    expect(nb.rotate).toBe(15);
    expect(after.frames.top.aspect).toBeCloseTo(200 / 120, 6);
  });

  it('a quarter-turned frame turns its layers so they stay put', () => {
    const from: ImpressFrame = { ...frame(100, 100), ax: [0, 0, 1], ay: [-1, 0, 0], origin: [100, 100, 0] };
    const to = frame(100, 100);
    const b = makeBlock({ kind: 'image', name: 'a', dataUrl: 'x' }, { surface: 'top', x: 0.5, y: 0.5, scale: 0.2, rotate: 0 });
    const nb = refitBlocks({ ...newComposition(), blocks: [b] }, 'top', from, to).blocks[0];
    expect(Math.abs(nb.rotate)).toBe(90);
  });

  it('hit-tests the topmost layer inside its turned rectangle', () => {
    const f = frame(200, 100);
    const a = makeBlock({ kind: 'image', name: 'a', dataUrl: 'x' }, { surface: 'top', x: 0.5, y: 0.5, scale: 0.5 });
    const b = makeBlock({ kind: 'image', name: 'b', dataUrl: 'y' }, { surface: 'top', x: 0.55, y: 0.5, scale: 0.1, rotate: 45 });
    const comp = { ...newComposition(), blocks: [a, b] };
    const dims = () => ({ w: 10, h: 10 });
    expect(blockAt(comp, 'top', 0.55, 0.5, dims, f)?.id).toBe(b.id);
    expect(blockAt(comp, 'top', 0.3, 0.5, dims, f)?.id).toBe(a.id);
    expect(blockAt(comp, 'top', 0.05, 0.05, dims, f)).toBeNull();
    const cs = blockCorners(a, { w: 10, h: 10 }, f);
    expect(cs[0][0]).toBeCloseTo(0.25, 6);
    expect(cs[2][1]).toBeCloseTo(0.5 + 50 / 100, 6);
  });

  it('a layer set deeper than the surface raises the surface and keeps the others at their depth', () => {
    const v = run({}, {}).v;
    const vv = { ...v, topDepth: 10 };
    const a = makeBlock({ kind: 'image', name: 'a', dataUrl: 'x' }, { surface: 'top', opacity: 0.5 });
    const b = makeBlock({ kind: 'image', name: 'b', dataUrl: 'y' }, { surface: 'top', opacity: 1 });
    const comp = { ...newComposition(), blocks: [a, b] };
    const shallow = setLayerDepth(comp, 'top', b.id, 4, vv);
    expect(shallow.patch).toEqual({});
    expect(shallow.comp.blocks[1].opacity).toBeCloseTo(0.4, 6);
    const deep = setLayerDepth(comp, 'top', b.id, 20, vv);
    expect(deep.patch).toEqual({ topDepth: 20 });
    const v2 = { ...vv, topDepth: 20 };
    expect(layerDepth(deep.comp.blocks[0], 'top', v2)).toBeCloseTo(5, 6);
    expect(layerDepth(deep.comp.blocks[1], 'top', v2)).toBeCloseTo(20, 6);
  });

  it('front depth rounds to whole plates', () => {
    const v = { ...run({}, {}).v, pitch: 10, frontDepth: 2, imgFrontStrength: 1 };
    const b = makeBlock({ kind: 'image', name: 'a', dataUrl: 'x' }, { surface: 'front', opacity: 1 });
    const r = setLayerDepth({ ...newComposition(), blocks: [b] }, 'front', b.id, 46, v);
    expect(r.patch).toEqual({ frontDepth: 5, imgFrontStrength: 1 });
  });

  it('the x-ray depth field follows the slicer: top in mm with steps, front in whole plates', () => {
    const v = run({}, {}).v;
    const img: Gray = { w: 3, h: 1, data: Float32Array.from([1, 0.5, 0]) };
    const f = frame(30, 10);
    const top = depthField('top', { ...v, imgTopMode: 'carve', topProfile: 'tone', topThreshold: 0, topSteps: 0, topDepth: 20 }, img, f);
    expect([...top]).toEqual([0, 10, 20]);
    const front = depthField('front', { ...v, frontDepth: 4, imgFrontStrength: 1, pitch: 5 }, img, f);
    expect([...front]).toEqual([0, 10, 20]);
  });

  it('filling the top surface resets the picture size, offset and turn', () => {
    const v = run({ topScale: '0.7', topX: '20', topRotate: '90' }, {}).v;
    expect(fillPatch('top', v)).toEqual({ topScale: 1, topX: 0, topRotate: '0' });
    expect(fillPatch('front', v)).toEqual({});
  });
});
