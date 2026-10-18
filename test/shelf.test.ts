import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject, deserialize, serialize } from '../src/core/project';
import { DEFAULT_SHELF, parseCards, shelfCards, type ShelfLayout } from '../src/core/shelf';
import { objectGeometry } from '../src/core/objects';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

describe('postcard shelf', () => {
  it('reads typed card sizes in the usual ways', () => {
    const { cards, bad } = parseCards('148 x 105 Venice\n150×100; 105 by 148, 6x4\nhello');
    expect(cards.map((c) => [c.w, c.h])).toEqual([[148, 105], [150, 100], [105, 148]]);
    expect(cards[0].name).toBe('Venice');
    expect(bad).toEqual(['6x4', 'hello']);
  });

  it.each(['fan', 'bands', 'arch', 'spiral'] as ShelfLayout[])('%s lays every card edge to edge without overlaps', (layout) => {
    const cards = shelfCards({ ...DEFAULT_SHELF, layout }, 120);
    expect(cards.length).toBe(parseCards(DEFAULT_SHELF.cards).cards.length);
    const boxes = cards.map((c) => objectGeometry(c).boundingBox!);
    // every card's bottom sits seat mm under the lift line (bands and spiral climb from there)
    for (const b of boxes) expect(b.min.y).toBeGreaterThan(120 + DEFAULT_SHELF.lift - DEFAULT_SHELF.seat - 20);
    // neighbours in the same row are about (w1 + w2) / 2 + gap apart
    for (let i = 1; i < cards.length; i++) {
      const a = cards[i - 1];
      const b = cards[i];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const want = (a.w + b.w) / 2 + DEFAULT_SHELF.gap;
      if (layout === 'bands' && d > want * 1.3) continue; // start of the next row
      expect(d).toBeGreaterThan(want * 0.85);
      expect(d).toBeLessThan(want * 1.15);
    }
  });

  it('trims the plates down to the cards and notches each one', () => {
    const compute = createPipeline();
    const p = newProject();
    const m0 = compute(p, assets);
    const shelf = { ...DEFAULT_SHELF, cards: '148 x 105\n148 x 105\n148 x 105', radius: 600 };
    const m = compute({ ...p, shelf }, assets);
    expect(m.objects.length).toBe(3);
    // the plates under the cards now top out at lift (+ shoulders up to the seat), not the strata
    const tops = m.sliced.plates.filter((q) => q.parts.length).map((q) => Math.max(...q.parts.map((x) => x.bbox.maxY)));
    expect(Math.max(...tops)).toBeLessThan(DEFAULT_SHELF.lift + 6);
    expect(Math.max(...tops)).toBeGreaterThan(DEFAULT_SHELF.lift - 6);
    expect(m.sliced.parts.length).toBeGreaterThanOrEqual(m0.sliced.parts.length);
    const back = deserialize(serialize({ ...p, shelf }));
    expect(back.shelf).toEqual(shelf);
  });
});

describe('postcard shelf choke', () => {
  it('stops the plates at the cards, padded, and leaves out plates that miss them', () => {
    const compute = createPipeline();
    const p = newProject();
    const shelf = { ...DEFAULT_SHELF, cards: '148 x 105\n148 x 105\n148 x 105', radius: 600 };
    const full = compute({ ...p, shelf }, assets);
    const each = compute({ ...p, shelf: { ...shelf, choke: 'cards' as const, pad: 10 } }, assets);
    const band = compute({ ...p, shelf: { ...shelf, choke: 'shelf' as const, pad: 10 } }, assets);
    const steel = (m: typeof full) => m.sliced.parts.filter((q) => q.family === 'P').reduce((a, q) => a + q.area, 0);
    expect(steel(each)).toBeGreaterThan(0);
    expect(steel(each)).toBeLessThan(steel(full) * 0.6);
    expect(steel(band)).toBeGreaterThanOrEqual(steel(each) - 1);
    // the card bottom edges in plan, from the card meshes themselves
    const edges = each.objects.map((o) => {
      const pos = objectGeometry(o.object).attributes.position;
      const pts = Array.from({ length: pos.count }, (_, i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
      const low = Math.min(...pts.map((q) => q[1]));
      const bottom = pts.filter((q) => q[1] < low + 2);
      const [a, b] = bottom.reduce(
        (best, q) => {
          for (const r of bottom) if (Math.hypot(q[0] - r[0], q[2] - r[2]) > Math.hypot(best[0][0] - best[1][0], best[0][2] - best[1][2])) best = [q, r];
          return best;
        },
        [bottom[0], bottom[0]],
      );
      return [a, b];
    });
    const toSeg = (x: number, z: number, [a, b]: number[][]) => {
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(x - a[0] - t * dx, z - a[2] - t * dz);
    };
    // every choked piece lies within reach of a card's bottom edge: half the card + clearance + pad (+ lean and thickness slop)
    const reach = DEFAULT_SHELF.thick / 2 + DEFAULT_SHELF.clearance + 10 + 2;
    for (const q of each.sliced.parts.filter((x) => x.family === 'P')) {
      const mid = (q.bbox.minX + q.bbox.maxX) / 2;
      const wx = q.plane.origin[0] + mid * q.plane.u[0];
      const wz = q.plane.origin[2] + mid * q.plane.u[2];
      expect(Math.min(...edges.map((e) => toSeg(wx, wz, e)))).toBeLessThan(reach);
    }
    // saves and opens with the choke
    expect(deserialize(serialize({ ...p, shelf: { ...shelf, choke: 'shelf' as const, pad: 10 } })).shelf).toMatchObject({ choke: 'shelf', pad: 10 });
  });

  it('keeps old shelves full length', () => {
    const p = newProject();
    const old = JSON.parse(serialize({ ...p, shelf: DEFAULT_SHELF }));
    delete old.shelf.choke;
    delete old.shelf.pad;
    expect(deserialize(JSON.stringify(old)).shelf).toMatchObject({ choke: 'off', pad: 15 });
  });
});

import { rainbowBuckets, defaultAppearance } from '../src/core/appearance';
describe('rainbow anodising', () => {
  it('splits the plates into equal coloured runs and replaces an earlier rainbow', () => {
    const keys = Array.from({ length: 40 }, (_, i) => `P${i}`);
    const a = rainbowBuckets(defaultAppearance(), keys, 7);
    expect(a.buckets.filter((b) => b.id.startsWith('rb')).map((b) => b.name)).toEqual(['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Indigo', 'Violet']);
    expect(a.buckets.every((b) => !b.id.startsWith('rb') || (b.material === 'aluminium' && b.finish === 'anodised'))).toBe(true);
    expect(a.assign.P0).toBe('rb1');
    expect(a.assign.P39).toBe('rb7');
    const b = rainbowBuckets(a, keys, 3);
    expect(b.buckets.filter((x) => x.id.startsWith('rb')).length).toBe(3);
    expect(new Set(Object.values(b.assign))).toEqual(new Set(['rb1', 'rb2', 'rb3']));
  });
});

import { originFrame, toWorld } from '../src/core/origin';
import { newObject } from '../src/core/objects';
describe('world origin', () => {
  it('measures objects from the chosen spot, turned, and leaves shelf heights on the concrete', () => {
    const v = { baseLength: 800, baseWidth: 300, baseOn: true, baseHeight: 120 } as never;
    const f = originFrame({ ref: 'corner', x: 10, y: 5, z: 0, turn: 90 }, v);
    expect(f.p[0]).toBeCloseTo(-400, 6);
    expect(f.p[1]).toBeCloseTo(125, 6);
    expect(f.p[2]).toBeCloseTo(150 - 10, 6);
    const o = { ...newObject('box', [], { y: 0 }), x: 100, y: 20, z: 0 };
    const w = toWorld(o, f);
    expect(w.x).toBeCloseTo(-400, 6);
    expect(w.z).toBeCloseTo(140 - 100, 6);
    expect(w.y).toBeCloseTo(145, 6);
    expect(w.ry).toBeCloseTo(90, 6);
    expect(toWorld(o, f)).toBe(w);
    expect(toWorld(o, f, true).y).toBe(20);
    expect(toWorld(o, originFrame(undefined, v))).toBe(o);
  });
});
