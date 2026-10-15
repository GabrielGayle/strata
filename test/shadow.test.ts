import { describe, expect, it } from 'vitest';
import { createFrontPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { renderWall, cleanShadow } from '../src/core/shadow';
import type { Gray } from '../src/core/image';

/** A test picture: white blob on black, w × h, lit where `on(x, y)` (0..1, y down). */
function pic(on: (x: number, y: number) => boolean, w = 60, h = 40): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = on((x + 0.5) / w, (y + 0.5) / h) ? 1 : 0;
  return { w, h, data };
}

// no insert (its cavity keeps a solid rim too); frames a quarter of an hour apart either side of noon, so rays stay inside the plates' side rims
const frames = [
  pic((x) => x < 0.3), // bar on the left
  pic((x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 < 0.06), // disc in the middle
  pic((x, y) => x > 0.7 && y < 0.6), // block top right
];

function setup(extra: Record<string, string | number | boolean> = {}) {
  const p = newProject();
  p.params = { ...p.params, sunOn: true, shadowOn: true, sunMonth: '12', sunDay: 21, sunLat: 51.5, sunLon: 0, sunUtc: 0, sunFacing: 180, shadowW: 120, shadowH: 80, insertOn: false, ...extra };
  p.shadow = { frames: frames.map((_, i) => ({ id: `f${i}`, name: `F${i}`, dataUrl: `data:x${i}`, time: 11.75 + i * 0.25, hold: 0 })) };
  const front = createFrontPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null, shadowFrames: frames });
  return front;
}

describe('shadow carving', () => {
  const f = setup();
  it('carves the plates and scores every frame', () => {
    expect(f.shadow).not.toBeNull();
    const rep = f.shadow!;
    expect(rep.scores).toHaveLength(3);
    for (const s of rep.scores) {
      expect(s.problem).toBeNull();
      expect(s.match).toBeGreaterThan(0.6);
    }
    expect(rep.removed).toBeGreaterThan(0.005);
    expect(rep.removed).toBeLessThan(0.5);
  });

  it('cuts real holes, and every part stays one piece', () => {
    const holed = f.sliced.parts.filter((p) => p.shape[0].holes.length > 0);
    expect(holed.length).toBeGreaterThan(3);
    for (const p of f.sliced.parts) expect(p.shape).toHaveLength(1);
  });

  it('shows each picture only around its own time', () => {
    const rep = f.shadow!;
    const lit = (t: number) => renderWall(f.v, rep, t).lit;
    const tgt = rep.targets[0];
    const agree = (a: Uint8Array) => {
      let both = 0, either = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] && tgt[i]) both++;
        if (a[i] || tgt[i]) either++;
      }
      return both / either;
    };
    expect(agree(lit(11.75))).toBeGreaterThan(0.6);
    expect(agree(lit(12))).toBeLessThan(agree(lit(11.75)) - 0.2);
  });

  it('flags a frame when the sun is behind the wall', () => {
    const g = setup({ sunFacing: 0 });
    expect(g.shadow!.scores.every((s) => s.problem)).toBe(true);
  });

  it('leaves the plates alone when off', () => {
    const g = setup({ shadowOn: false });
    expect(g.shadow).toBeNull();
  });

  it('cleans saved frames', () => {
    expect(cleanShadow({ frames: [{ dataUrl: 'data:a', time: 30, hold: -5 }, { nope: 1 }] })).toEqual({ frames: [{ id: 'f1', name: 'Frame 1', dataUrl: 'data:a', time: 24, hold: 0 }] });
    expect(cleanShadow(null)).toBeUndefined();
  });
});
