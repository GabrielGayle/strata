// Candelabra on a wall piece: the path is laid out on the face of the wall, Crown and
// Climb lift candles up it, fin holders become cheek fins slotted onto level plates, and
// candles with no plate round them (or standing inside each other) are warned about.
import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject, type Project } from '../src/core/project';
import { DEFAULT_CANDLES, type CandleSpec } from '../src/core/candles';
import { mountFrame } from '../src/core/mount';
import { onWallFace } from '../src/core/wallBuild';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

const wall = (params: Record<string, string>, c: Partial<CandleSpec>): Project => {
  const p = newProject();
  return {
    ...p,
    params: { ...p.params, insShape: 'none', strataOn: 'false', mount: 'wall', baseOn: 'true', baseMaterial: 'steel', baseLength: '420', baseWidth: '300', thickness: '2', plateCount: '8', sliceMode: 'parallel', stackHeight: '60', ...params } as Project['params'],
    candles: { ...DEFAULT_CANDLES, crown: 0, ramp: 0, path: 'line', size: 220, snap: 'off', lift: 8, ...c },
  };
};
const build = (p: Project) => createPipeline()(p, assets);
const candlesOf = (m: ReturnType<typeof build>) => m.objects.filter((b) => b.object.id.startsWith('candle')).map((b) => b.object);
const fins = (m: ReturnType<typeof build>) => m.sliced.parts.filter((q) => q.id.startsWith('K') || q.id.startsWith('SK'));

describe('wall candelabra', () => {
  it('turns slotted fins into two cheek fins per candlestick when the plates run across', () => {
    const m = build(wall({ wallPlates: 'across' }, { candles: '3 taper', holder: 'slotted' }));
    expect(m.wallLevel).toBe(true);
    expect(fins(m).length).toBe(6);
    expect(m.sliced.warnings.join(' ')).not.toMatch(/hang loose/);
  });

  it('makes target fins cheek fins too on level plates', () => {
    const m = build(wall({ wallPlates: 'across' }, { candles: '2 taper', holder: 'target' }));
    expect(fins(m).length).toBe(4);
  });

  it('gives cups, not fins, when the plates hang down the wall', () => {
    const m = build(wall({ wallPlates: 'down' }, { candles: '3 taper', holder: 'slotted' }));
    expect(m.wallLevel).toBeFalsy();
    expect(fins(m).length).toBe(0);
  });

  it('lays a line of candles out across the wall face, not stacked in one column', () => {
    for (const wallPlates of ['across', 'down']) {
      const m = build(wall({ wallPlates }, { candles: '3 taper', holder: 'socket' }));
      const f = mountFrame(m.v);
      const along = candlesOf(m).map((o) => o.x * f.right[0] + o.z * f.right[2]);
      expect(Math.max(...along) - Math.min(...along)).toBeGreaterThan(150);
    }
  });

  it('maps the plan path onto the wall face and lifts by the candle rise', () => {
    const f = mountFrame({ ...newProject().params, mount: 'wall', wallPlates: 'across' } as never);
    const [a] = onWallFace([{ id: 'c', x: 50, y: 40 + 30 + 10, z: 0, w: 20, h: 60 } as never], f, 10, 0);
    expect(a.y).toBe(20);
    // 50 along the path is 50 along the wall's right; rising 40 lifts it 40 up the wall
    expect(a.x * f.right[0] + a.z * f.right[2]).toBeCloseTo(50);
    expect(a.x * f.up[0] + a.z * f.up[2]).toBeCloseTo(40);
  });

  it('Crown lifts the middle candle higher up the wall', () => {
    const flat = build(wall({ wallPlates: 'down' }, { candles: '3 taper', holder: 'socket', snap: 'off' }));
    const crowned = build(wall({ wallPlates: 'down' }, { candles: '3 taper', holder: 'socket', snap: 'off', crown: 60 }));
    const f = mountFrame(flat.v);
    const upOf = (m: ReturnType<typeof build>) => candlesOf(m).map((o) => o.x * f.up[0] + o.z * f.up[2]);
    expect(upOf(crowned)[1] - upOf(flat)[1]).toBeGreaterThan(30);
  });

  it('warns about a candle with no plate round it', () => {
    const m = build(wall({ wallPlates: 'down' }, { candles: '3 taper', holder: 'socket', x: 900 }));
    expect(m.issues.map((i) => i.message).join(' ')).toMatch(/no plate round/);
  });

  it('warns when candles stand inside each other', () => {
    const m = build(wall({ wallPlates: 'down' }, { candles: '4 taper', holder: 'socket', size: 20 }));
    expect(m.issues.map((i) => i.message).join(' ')).toMatch(/inside each other/);
  });
});
