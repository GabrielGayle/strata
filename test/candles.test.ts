import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject, deserialize, serialize } from '../src/core/project';
import { candleList, candleObjects, DEFAULT_CANDLES, parseCandles, pathPolyline, spreadAlong, type CandlePath } from '../src/core/candles';
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

  it('saves, shares and comes back the same', () => {
    const p = { ...newProject(), candles: { ...DEFAULT_CANDLES, path: 'heart' as const, size: 400 } };
    expect(deserialize(serialize(p)).candles).toEqual(p.candles);
    expect(projectFromShare(shareState(p)).candles).toEqual(p.candles);
  });
});
