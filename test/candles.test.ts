import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject, deserialize, serialize } from '../src/core/project';
import { addCandle, candleList, candleObjects, DEFAULT_CANDLES, parseCandles, pathPolyline, spreadAlong, writeCandles, type CandlePath } from '../src/core/candles';
import { projectFromShare, shareState } from '../src/core/share';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

describe('candelabra', () => {
  it('reads presets, counts, sizes and holder words', () => {
    const { lines, bad } = parseCandles('5 tapers\ntealight\n40 x 18 tealight\n24 x 300 socket\nmaxi; 3× votive\nwhatever');
    expect(lines.map((l) => [l.size.d, l.size.h, l.count, l.size.tealight])).toEqual([
      [22, 250, 5, false],
      [38, 16, 1, true],
      [40, 18, 1, true],
      [24, 300, 1, false],
      [58, 24, 1, true],
      [45, 60, 3, true],
    ]);
    expect(lines[3].size.holder).toBe('socket');
    expect(bad).toEqual(['whatever']);
  });

  it('alternates the lines along the run', () => {
    const list = candleList({ ...DEFAULT_CANDLES, candles: '3 taper\n2 tealight' });
    expect(list.map((c) => (c.tealight ? 't' : 'S')).join('')).toBe('StStS');
    expect(candleList({ ...DEFAULT_CANDLES, candles: '3 taper\n2 tealight', alternate: false }).map((c) => (c.tealight ? 't' : 'S')).join('')).toBe('SSStt');
  });

  it.each(['line', 'arc', 'wave', 'circle', 'spiral', 'heart', 'star', 'custom'] as CandlePath[])('%s spaces candles evenly and keeps them apart', (path) => {
    const spec = { ...DEFAULT_CANDLES, path, candles: '8 taper', bend: path === 'star' ? 5 : path === 'spiral' ? 1.5 : DEFAULT_CANDLES.bend };
    const { pts, closed } = pathPolyline(spec);
    expect(pts.length).toBeGreaterThan(1);
    const spots = spreadAlong(pts, closed, 8);
    expect(spots.length).toBe(8);
    const objs = candleObjects(spec, 100).filter((o) => o.id.startsWith('candle'));
    expect(objs.length).toBe(8);
    for (let i = 1; i < objs.length; i++) expect(Math.hypot(objs[i].x - objs[i - 1].x, objs[i].z - objs[i - 1].z)).toBeGreaterThan(20);
  });

  it('crowns the middle candles and lifts them off the concrete', () => {
    const objs = candleObjects({ ...DEFAULT_CANDLES, path: 'line', candles: '5 taper', crown: 50 }, 100).filter((o) => o.id.startsWith('candle'));
    const bottoms = objs.map((o) => o.y - o.h / 2);
    expect(bottoms[0]).toBeCloseTo(100 + DEFAULT_CANDLES.lift);
    expect(bottoms[2]).toBeCloseTo(100 + DEFAULT_CANDLES.lift + 50);
    expect(bottoms[4]).toBeCloseTo(bottoms[0]);
  });

  it('holds candlesticks with target fins and tealights in cups the plates step up to', () => {
    const compute = createPipeline();
    const p = newProject();
    const candles = { ...DEFAULT_CANDLES, candles: '3 taper\n2 tealight', crown: 0 };
    const m = compute({ ...p, params: { ...p.params, strataOn: false, stackHeight: '200' }, candles }, assets);
    const fins = m.sliced.parts.filter((q) => q.family === 'K');
    expect(fins.length).toBe(3 * DEFAULT_CANDLES.fins);
    // each fin rises the grip above the candle's bottom (plate coordinates: 0 is the top of the concrete)
    for (const f of fins) expect(f.bbox.maxY).toBeCloseTo(DEFAULT_CANDLES.lift + DEFAULT_CANDLES.grip, 0);
    // the plates step down to the candle seats, nowhere near the 200 mm they were asked for
    const tops = m.sliced.plates.filter((q) => q.parts.length && q.def.family === 'P').map((q) => Math.max(...q.parts.map((x) => x.bbox.maxY)));
    expect(Math.max(...tops)).toBeLessThan(DEFAULT_CANDLES.lift + DEFAULT_CANDLES.cup + 5);
    expect(Math.max(...tops)).toBeGreaterThan(DEFAULT_CANDLES.lift - 2);
  });

  it('socket-held candlesticks need no fins', () => {
    const compute = createPipeline();
    const p = newProject();
    const m = compute({ ...p, candles: { ...DEFAULT_CANDLES, holder: 'socket' } }, assets);
    expect(m.sliced.parts.some((q) => q.family === 'K')).toBe(false);
    expect(m.objects.some((o) => o.object.look === 'hidden')).toBe(false);
  });

  it('slotted fins key into the plates with halving slots and need no well', () => {
    const compute = createPipeline();
    const p = newProject();
    const candles = { ...DEFAULT_CANDLES, candles: '3 taper', crown: 0, holder: 'slotted' as const };
    const m = compute({ ...p, params: { ...p.params, strataOn: false, stackHeight: '200' }, candles }, assets);
    const fins = m.sliced.parts.filter((q) => q.family === 'K');
    expect(fins.length).toBe(3 * DEFAULT_CANDLES.fins);
    // they hang into the plates by the engagement, not down into the concrete
    for (const f of fins) {
      expect(f.bbox.minY).toBeCloseTo(DEFAULT_CANDLES.lift - DEFAULT_CANDLES.engage, 0);
      expect(f.bbox.maxY).toBeCloseTo(DEFAULT_CANDLES.lift + DEFAULT_CANDLES.grip, 0);
    }
    // at 45° every fin crosses plates, so each one has slot notches (more corners than the plain outline)
    for (const f of fins) expect(f.shape[0].outer.length).toBeGreaterThan(7);
    expect(m.sliced.warnings.some((w) => w.includes('slotted candle fin'))).toBe(false);
    // nothing clears a well: the hidden pads only shape the plate tops
    expect(m.objects.filter((o) => o.object.look === 'hidden').every((o) => o.object.noCut)).toBe(true);
    // fins running along the plates can't slot, and say so
    const along = compute({ ...p, params: { ...p.params, strataOn: false, stackHeight: '200' }, candles: { ...candles, spin: 0 } }, assets);
    expect(along.sliced.warnings.some((w) => w.includes('slotted candle fin'))).toBe(true);
  });

  it('reads cup and slotted on a line', () => {
    const { lines } = parseCandles('2 taper cup\n24 x 300 slotted');
    expect(lines.map((l) => l.size.holder)).toEqual(['socket', 'slotted']);
  });

  it('saves, shares and comes back the same', () => {
    const p = { ...newProject(), candles: { ...DEFAULT_CANDLES, path: 'heart' as const, size: 400 } };
    expect(deserialize(serialize(p)).candles).toEqual(p.candles);
    expect(projectFromShare(shareState(p)).candles).toEqual(p.candles);
  });
});

describe('candelabra choke', () => {
  it('stops the plates round the candles, padded, and leaves out plates that miss them', () => {
    const compute = createPipeline();
    const p = newProject();
    const params = { ...p.params, strataOn: false, stackHeight: '120' };
    const spec = { ...DEFAULT_CANDLES, candles: '5 tealight', path: 'line' as const, size: 300, crown: 0 };
    const full = compute({ ...p, params, candles: spec }, assets);
    const each = compute({ ...p, params, candles: { ...spec, choke: 'candles' as const, pad: 10 } }, assets);
    const band = compute({ ...p, params, candles: { ...spec, choke: 'path' as const, pad: 10 } }, assets);
    const steel = (m: typeof full) => m.sliced.parts.filter((q) => q.family === 'P').reduce((a, q) => a + q.area, 0);
    expect(steel(each)).toBeLessThan(steel(full) * 0.5);
    expect(steel(band)).toBeGreaterThanOrEqual(steel(each) - 1);
    // every choked piece lies within reach of a candle: tealight radius + slack + pad
    const reach = 19 + DEFAULT_CANDLES.slack + 10 + 0.5;
    const cs = each.objects.filter((o) => o.object.id.startsWith('candle')).map((o) => o.object);
    for (const q of each.sliced.parts.filter((x) => x.family === 'P')) {
      const mid = (q.bbox.minX + q.bbox.maxX) / 2;
      const wx = q.plane.origin[0] + mid * q.plane.u[0];
      const wz = q.plane.origin[2] + mid * q.plane.u[2];
      expect(Math.min(...cs.map((c) => Math.hypot(c.x - wx, c.z - wz)))).toBeLessThan(reach);
    }
  });
});

describe('candles sitting into the plates', () => {
  it('sink into whatever plates are under them and leave the plate tops alone', () => {
    const compute = createPipeline();
    const p = newProject();
    const spec = { ...DEFAULT_CANDLES, candles: '4 tealight', path: 'line' as const, size: 300, sit: 'surface' as const };
    const bare = compute(p, assets);
    const m = compute({ ...p, candles: spec }, assets);
    // the plates keep their own tops (no stepping), apart from the cups cut into them
    const top = (mm: typeof m) => Math.max(...mm.sliced.parts.filter((q) => q.family === 'P').map((q) => q.bbox.maxY));
    expect(top(m)).toBeCloseTo(top(bare), 0);
    // each tealight sits its cup depth under the lowest plate top it crosses
    for (const b of m.objects.filter((o) => o.object.id.startsWith('candle'))) {
      const o = b.object;
      const bottom = o.y - o.h / 2;
      const crossing = bare.sliced.parts.filter((q) => q.family === 'P' && Math.abs((o.x - q.plane.origin[0]) * q.plane.normal[0] + (o.z - q.plane.origin[2]) * q.plane.normal[2]) < o.w / 2 + o.clearance);
      expect(crossing.length).toBeGreaterThan(0);
      expect(bottom).toBeLessThan(Math.max(...crossing.map((q) => q.plane.origin[1] + q.bbox.maxY)));
      expect(o.seat).toBeUndefined();
    }
  });

  it('auto sits into a map and lifts otherwise', () => {
    const objs = candleObjects({ ...DEFAULT_CANDLES, sit: 'auto' }, 100, true).filter((o) => o.id.startsWith('candle'));
    expect(objs.every((o) => o.sink !== undefined && o.seat === undefined)).toBe(true);
    const lifted = candleObjects({ ...DEFAULT_CANDLES, sit: 'auto' }, 100, false).filter((o) => o.id.startsWith('candle'));
    expect(lifted.every((o) => o.sink === undefined)).toBe(true);
  });
});

import { defaultMapSpec } from '../src/core/mapSpec';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { mapDepthToGray } from '../src/core/mapPlateHeight';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('candles on a map', () => {
  it('sit into the terrain plates instead of floating, and cut cups in them', () => {
    const { depth } = mapGridToDepth(syntheticConeGrid(48, 24, 18), { exaggeration: 5, bbox: NEASDEN_FAST_BBOX });
    const p = newProject();
    p.params = { ...p.params, baseLength: '600', baseWidth: '600', plateCount: '24', thickness: '3', stackHeight: '200' };
    p.images.top = { name: 'Map', dataUrl: 'data:image/png;base64,xx', map: defaultMapSpec({ bbox: NEASDEN_FAST_BBOX, title: 'Cone' }), depth };
    const a = { sideImg: null, frontImg: null, topImg: mapDepthToGray(depth), insMesh: null, srcMesh: null };
    const bare = createPipeline()(p, a);
    const m = createPipeline()({ ...p, candles: { ...DEFAULT_CANDLES, candles: '5 tealight', path: 'circle', size: 300 } }, a);
    const area = (mm: typeof m) => mm.sliced.parts.filter((q) => q.family === 'P').reduce((s, q) => s + q.area, 0);
    // cups come out of the terrain, nothing is stepped off it
    expect(area(m)).toBeLessThan(area(bare));
    expect(area(m)).toBeGreaterThan(area(bare) * 0.97);
    for (const b of m.objects.filter((o) => o.object.id.startsWith('candle'))) {
      const o = b.object;
      const bottom = o.y - o.h / 2;
      const tops = bare.sliced.parts
        .filter((q) => q.family === 'P' && Math.abs((o.x - q.plane.origin[0]) * q.plane.normal[0] + (o.z - q.plane.origin[2]) * q.plane.normal[2]) < o.w / 2)
        .map((q) => q.plane.origin[1] + q.bbox.maxY);
      expect(tops.length).toBeGreaterThan(0);
      // well below the highest terrain it crosses: held, not floating
      expect(bottom).toBeLessThan(Math.max(...tops));
    }
  });

  it('slots target fins onto the terrain instead of clearing a hole for them down to the concrete', () => {
    const { depth } = mapGridToDepth(syntheticConeGrid(48, 24, 18), { exaggeration: 5, bbox: NEASDEN_FAST_BBOX });
    const p = newProject();
    p.params = { ...p.params, baseLength: '600', baseWidth: '600', plateCount: '60', thickness: '3', stackHeight: '200' };
    p.images.top = { name: 'Map', dataUrl: 'data:image/png;base64,xx', map: defaultMapSpec({ bbox: NEASDEN_FAST_BBOX, title: 'Cone' }), depth };
    const a = { sideImg: null, frontImg: null, topImg: mapDepthToGray(depth), insMesh: null, srcMesh: null };
    const bare = createPipeline()(p, a);
    const m = createPipeline()({ ...p, candles: { ...DEFAULT_CANDLES, holder: 'target' } }, a);
    const area = (mm: typeof m) => mm.sliced.parts.filter((q) => q.family === 'P').reduce((s, q) => s + q.area, 0);
    // the plates keep their terrain, just cut for the cups and fin slots (a well per candlestick took 6% of it here)
    expect(area(m)).toBeGreaterThan(area(bare) * 0.97);
    expect(m.objects.some((o) => o.object.id.startsWith('well'))).toBe(false);
    const sticks = m.objects.filter((o) => o.object.id.startsWith('candle') && o.object.holder).map((o) => o.object);
    expect(sticks.length).toBe(5);
    expect(sticks.every((o) => o.holder!.slotted)).toBe(true);
    // the fins hang from the candle into the plates, they don't stand up from the concrete
    for (const f of m.sliced.parts.filter((q) => q.family === 'K')) expect(f.bbox.minY).toBeGreaterThan(0);
  });
});

import { candleSpots, localToSpot, spotToLocal } from '../src/core/candles';
import { plateDefs } from '../src/core/slicer';
import { evaluateParams } from '../src/core/params';

describe('candle placement', () => {
  it('lays a grid row by row and spaces snapped columns by whole plates', () => {
    const spots = candleSpots({ ...DEFAULT_CANDLES, path: 'grid', cols: 3, gapX: 50, gapZ: 40 }, 6);
    expect(spots.map((s) => s.p)).toEqual([[-50, -20], [0, -20], [50, -20], [-50, 20], [0, 20], [50, 20]]);
    const snapped = candleSpots({ ...DEFAULT_CANDLES, path: 'grid', cols: 3, snap: 'on', every: 4 }, 3, 18.5);
    expect(snapped[1].p[0] - snapped[0].p[0]).toBeCloseTo(74);
  });

  it('snaps candles onto plates or midway between them', () => {
    const p = newProject();
    const planes = plateDefs(evaluateParams(p.params).values).filter((d) => d.family === 'P').map((d) => d.plane);
    const n = planes[0].normal;
    const offs = planes.map((q) => q.origin[0] * n[0] + q.origin[2] * n[2]);
    const compute = createPipeline();
    for (const snap of ['on', 'between'] as const) {
      const m = compute({ ...p, candles: { ...DEFAULT_CANDLES, path: 'grid', candles: '6 tealight', cols: 3, snap } }, assets);
      for (const b of m.objects.filter((o) => o.object.id.startsWith('candle'))) {
        const s = b.object.x * n[0] + b.object.z * n[2];
        const best = Math.min(...offs.map((o) => Math.abs(o - s)));
        if (snap === 'on') expect(best).toBeLessThan(0.01);
        else expect(Math.abs(best - Math.abs(offs[1] - offs[0]) / 2)).toBeLessThan(0.01);
      }
    }
  });

  it('free spots round-trip through the candelabra frame', () => {
    const spec = { ...DEFAULT_CANDLES, x: 30, z: -20, turn: 35 };
    const q = spotToLocal(spec, [12, 34]);
    const back = localToSpot(spec, q);
    expect(back[0]).toBeCloseTo(12);
    expect(back[1]).toBeCloseTo(34);
    const objs = candleObjects({ ...DEFAULT_CANDLES, path: 'free', candles: '2 tealight', spots: [[10, 20], [-40, 5]] }, 100).filter((o) => o.id.startsWith('candle'));
    expect(objs.map((o) => [o.x, o.z])).toEqual([[10, 20], [-40, 5]]);
  });
});

describe('candle shopping list', () => {
  it('groups the candles by size with counts, holders and hole sizes', async () => {
    const { candleShopping, candlesCsv } = await import('../src/core/candles');
    const rows = candleShopping({ ...DEFAULT_CANDLES, candles: '5 taper\n4 tealight\n2 taper socket', slack: 0.5 });
    expect(rows.map((r) => [r.name, r.d, r.h, r.qty, r.holder, r.hole])).toEqual([
      ['Dinner candle (taper)', 22, 250, 5, 'target', 23],
      ['Tealight', 38, 16, 4, 'socket', 39],
      ['Dinner candle (taper)', 22, 250, 2, 'socket', 23],
    ]);
    const csv = candlesCsv(rows).trim().split('\n');
    expect(csv[0]).toBe('candle,diameter_mm,height_mm,qty,kind,held_by,hole_mm');
    expect(csv[1]).toBe('Dinner candle (taper),22,250,5,candlestick,target fins,23');
    expect(csv.at(-1)).toBe('Total,,,11,,,');
    expect(candleShopping({ ...DEFAULT_CANDLES, on: false })).toEqual([]);
    expect(candleShopping(undefined)).toEqual([]);
  });

  it('puts candles.csv in the zip and the candles in the build pack', async () => {
    const { buildZip, buildPackHtmlChecked } = await import('../src/core/exporters');
    const { unzipSync, strFromU8 } = await import('fflate');
    const p = { ...newProject(), candles: { ...DEFAULT_CANDLES } };
    const m = createPipeline()(p, assets);
    const files = unzipSync(buildZip(m, p));
    const csv = strFromU8(files['candles.csv']);
    expect(csv).toContain('Dinner candle (taper),22,250,5');
    expect(csv).toContain('Tealight,38,16,4');
    expect(strFromU8(files['README.txt'])).toContain('candles.csv');
    const html = buildPackHtmlChecked(p, m);
    expect(html).toContain('data-candle-total="9"');
    const plain = { ...newProject() };
    expect(unzipSync(buildZip(createPipeline()(plain, assets), plain))['candles.csv']).toBeUndefined();
  });
});

describe('candle picker', () => {
  const strip = (t: string) => parseCandles(t).lines.map((l) => ({ count: l.count, d: l.size.d, h: l.size.h, tealight: l.size.tealight, holder: l.size.holder }));

  it('writes every kind of line back so it reads the same', () => {
    const text = '5 tapers\ntealight\n40 x 18 tealight\n24 x 300 socket\nmaxi; 3× votive\n2 taper cup\n24 x 300 slotted\n60 x 40\n30 x 200 my tea candle';
    const { lines, bad } = parseCandles(text);
    expect(bad).toEqual([]);
    expect(strip(writeCandles(lines))).toEqual(strip(text));
  });

  it('keeps a count on a size of your own', () => {
    const out = writeCandles([{ size: { d: 24, h: 300, tealight: false, name: '' }, count: 3 }]);
    expect(out).toBe('3 of 24 x 300');
    expect(strip(out)).toEqual([{ count: 3, d: 24, h: 300, tealight: false, holder: undefined }]);
  });

  it('adds one more to a matching line, or a new line', () => {
    expect(addCandle('5 taper\n4 tealight', { d: 38, h: 16, tealight: true, name: 'Tealight', preset: 'tealight' })).toBe('5 taper\n5 tealight');
    expect(addCandle('2 taper target', { d: 22, h: 250, tealight: false, name: 'Dinner candle (taper)', preset: 'taper' })).toBe('2 taper target\n1 taper');
    expect(addCandle('', { d: 58, h: 24, tealight: true, name: 'Maxi tealight', preset: 'maxi' })).toBe('1 maxi');
    expect(addCandle('oops', { d: 30, h: 12, tealight: true, name: 'Mini', preset: 'mini' })).toBe('1 mini\noops');
  });
});
