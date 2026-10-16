import { describe, expect, it } from 'vitest';
import { ANCHORS, blockExtent, changedSurfaces, layoutGrid, layoutLayers, liveComposition, pinLayers, seedId, settleComposition } from '../src/core/arrange';
import { makeBlock, newComposition, type Block, type Composition } from '../src/core/compose';

const img = (name: string) => ({ kind: 'image' as const, name, dataUrl: 'data:' + name });
const square = () => ({ w: 10, h: 10 });
const anchor = (id: string) => ANCHORS.find((a) => a.id === id)!;
const withBlocks = (aspect: number, ...bs: Block[]): Composition => ({ ...newComposition({ top: aspect }), blocks: bs });

describe('arranging layers', () => {
  it('pins a layer to the top left and bottom right corners, margin kept', () => {
    const b = makeBlock(img('a'), { scale: 0.2, x: 0.5, y: 0.5 });
    const c = withBlocks(2, b);
    const tl = pinLayers(c, 'top', [b.id], anchor('tl'), square, 0.1).blocks[0];
    // on a 2:1 frame a square 0.2 wide is 0.4 tall; 0.1 of the height is 0.05 of the width
    expect(tl.x).toBeCloseTo(0.05 + 0.1);
    expect(tl.y).toBeCloseTo(0.1 + 0.2);
    const br = pinLayers(c, 'top', [b.id], anchor('br'), square, 0).blocks[0];
    expect(br.x).toBeCloseTo(0.9);
    expect(br.y).toBeCloseTo(0.8);
  });

  it('pins several layers as one group, keeping their spacing', () => {
    const a = makeBlock(img('a'), { scale: 0.2, x: 0.4, y: 0.5 });
    const b = makeBlock(img('b'), { scale: 0.2, x: 0.7, y: 0.6 });
    const out = pinLayers(withBlocks(1, a, b), 'top', [a.id, b.id], anchor('tl'), square, 0).blocks;
    expect(out[0].x).toBeCloseTo(0.1);
    expect(out[0].y).toBeCloseTo(0.1);
    expect(out[1].x - out[0].x).toBeCloseTo(0.3);
    expect(out[1].y - out[0].y).toBeCloseTo(0.1);
  });

  it('accounts for a turn: a tall layer turned 90 degrees sits wide', () => {
    const b = makeBlock(img('a'), { scale: 0.2, rotate: 90 });
    const e = blockExtent(b, { w: 1, h: 2 }, 1);
    expect(e.w).toBeCloseTo(0.4);
    expect(e.h).toBeCloseTo(0.2);
  });

  it('lays four layers out in a 2x2 grid, top left first, each fitted to its cell', () => {
    const bs = ['a', 'b', 'c', 'd'].map((n) => makeBlock(img(n), { rotate: 30, scale: 1 }));
    const out = layoutLayers(withBlocks(1, ...bs), 'top', bs.map((b) => b.id), 'grid2', square, 0, 0).blocks;
    expect(out.map((b) => [b.x, b.y])).toEqual([
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ]);
    expect(out.every((b) => b.rotate === 0 && Math.abs(b.scale - 0.5) < 1e-9)).toBe(true);
  });

  it('fits a wide picture by its width and a tall one by its height', () => {
    const wide = makeBlock(img('w'));
    const tall = makeBlock(img('t'));
    const dims = (b: Block) => (b.source.kind === 'image' && b.source.name === 'w' ? { w: 4, h: 1 } : { w: 1, h: 4 });
    const out = layoutLayers(withBlocks(1, wide, tall), 'top', [wide.id, tall.id], 'row', dims, 0, 0).blocks;
    expect(out[0].scale).toBeCloseTo(0.5); // cell 0.5 x 1: width-limited
    expect(out[1].scale).toBeCloseTo(0.25); // height 1 means width 0.25
  });

  it('grows the grid when there are more layers than cells', () => {
    expect(layoutGrid('grid2', 3)).toEqual({ cols: 2, rows: 2 });
    expect(layoutGrid('grid2', 6)).toEqual({ cols: 2, rows: 3 });
    expect(layoutGrid('auto', 4)).toEqual({ cols: 2, rows: 2 });
    expect(layoutGrid('auto', 6, 1.5)).toEqual({ cols: 3, rows: 2 });
    expect(layoutGrid('auto', 4, 0.3)).toEqual({ cols: 1, rows: 4 }); // a long thin top
    expect(layoutGrid('row', 4)).toEqual({ cols: 4, rows: 1 });
  });
});

describe('live layers', () => {
  const pic = { name: 'p.png', dataUrl: 'data:p' };

  it('shows an ordinary picture as one full-frame layer with its own proportions', () => {
    const c = liveComposition({ front: pic }, undefined, 1, () => 2);
    const on = c.blocks.filter((b) => b.surface === 'front');
    expect(on).toHaveLength(1);
    expect(on[0].id).toBe(seedId('front'));
    expect(on[0].scale).toBe(1);
    expect(c.frames.front.aspect).toBe(2);
  });

  it('keeps layered surfaces, and parks old layers when the picture was replaced', () => {
    const comp = newComposition({ top: 1 });
    const kept = makeBlock(img('k'), { surface: 'top' });
    const old = makeBlock(img('o'), { surface: 'side' });
    comp.blocks.push(kept, old);
    const c = liveComposition({ top: { ...pic, composed: true }, side: pic }, comp, 1);
    expect(c.blocks.find((b) => b.id === kept.id)!.surface).toBe('top');
    expect(c.blocks.find((b) => b.id === old.id)!.surface).toBeNull();
    expect(c.blocks.find((b) => b.id === seedId('side'))!.surface).toBe('side');
  });

  it('turns a picture into a real layer only on the surface that changed', () => {
    const before = liveComposition({ top: pic, front: pic }, undefined, 1);
    const extra = makeBlock(img('x'), { surface: 'top' });
    const after = { ...before, blocks: [...before.blocks, extra] };
    const { comp, changed, renamed } = settleComposition(before, after);
    expect(changed).toEqual(['top']);
    // the top picture becomes a real block; the untouched front stays a plain picture
    expect(comp.blocks.some((b) => b.id.startsWith('seed-'))).toBe(false);
    expect(comp.blocks.filter((b) => b.surface === 'top')).toHaveLength(2);
    expect(comp.blocks.filter((b) => b.surface === 'front')).toHaveLength(0);
    expect(renamed.has(seedId('top'))).toBe(true);
  });

  it('moving a node on the board changes no surface', () => {
    const b = makeBlock(img('a'), { surface: 'top' });
    const a = withBlocks(1, b);
    const moved = { ...a, blocks: [{ ...b, node: { x: 40, y: 40 } }] };
    expect(changedSurfaces(a, moved)).toEqual([]);
    expect(changedSurfaces(a, { ...a, blocks: [{ ...b, x: 0.3 }] })).toEqual(['top']);
  });
});
