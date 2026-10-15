import { describe, expect, it } from 'vitest';
import { createFrontPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { renderWall, cleanShadow, wallPoint, windowDays, frameMatch } from '../src/core/shadow';
import { bestTry, fitLayouts, tryLayout } from '../src/core/shadowFit';
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
  p.params = { ...p.params, sunOn: true, shadowOn: true, sunMonth: '12', sunDay: 21, sunLat: 51.5, sunLon: 0, sunUtc: 0, sunFacing: 180, shadowW: 120, shadowH: 80, insertOn: false, shadowDays: 0, ...extra };
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

  it('counts the plates it actually cuts', () => {
    const rep = f.shadow!;
    expect(rep.cut).toBeGreaterThan(rep.plates / 2);
    expect(rep.cut).toBeLessThanOrEqual(rep.plates);
    // high June sun drops through the back of the stack: only the plates nearest the wall get cut
    const june = setup({ sunMonth: '6' }).shadow!;
    expect(june.cut).toBeLessThan(june.plates / 3);
  });

  it('holds useful loose bits in with bridges, and cuts the rest away', () => {
    const rep = f.shadow!;
    expect(rep.islands).toBeGreaterThan(0);
    expect(rep.bridged).toBeGreaterThan(0);
    expect(rep.bridged).toBeLessThanOrEqual(rep.islands);
    const none = setup({ shadowBridge: 0 });
    expect(none.shadow!.bridged).toBe(0);
    expect(none.sliced.warnings.some((w) => w.includes('cut away'))).toBe(true);
    // bridged steel stays: less is cut away than without bridges
    const area = (m: typeof f) => m.sliced.parts.reduce((a, p) => a + p.area, 0);
    expect(area(f)).toBeGreaterThan(area(none));
  });

  it('lays frames side by side where their light comes through the plates', () => {
    const side = setup({ shadowExec: 'side', shadowW: 50, shadowH: 40 });
    const g = side.shadow!.geom;
    expect(g.slots).toHaveLength(3);
    // in time order across the row, spaced by the sun's swing, all inside the screen grid
    const c0 = g.slots!.map((s) => s.c0);
    expect(new Set(c0).size).toBe(3);
    for (const s of g.slots!) expect(s.c0 + s.cols).toBeLessThanOrEqual(g.cols);
    // each frame lights only its own patch
    for (const [i, s] of g.slots!.entries()) {
      const t = side.shadow!.targets[i];
      for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if (t[r * g.cols + c]) expect(c >= s.c0 && c < s.c0 + s.cols).toBe(true);
    }
    for (const sc of side.shadow!.scores) expect(sc.match).toBeGreaterThan(0.6);
  });

  it('crossfade stretches each frame toward its neighbours', () => {
    const fade = setup({ shadowFade: 60 });
    expect(fade.shadow!.removed).toBeGreaterThan(f.shadow!.removed);
  });

  it('puts the picture on the ground, outside the concrete', () => {
    const g = setup({ shadowScreen: 'ground', shadowGap: 200 });
    const rep = g.shadow!;
    expect(rep.geom.screen).toBe('ground');
    expect(wallPoint(rep.geom, 0, rep.geom.y0)[1]).toBe(0);
    // grid under the base is not screen
    const under = setup({ shadowScreen: 'ground', shadowGap: -100 }).shadow!;
    expect(under.valid.some((x) => !x)).toBe(true);
    expect(rep.valid.every((x) => x)).toBe(true);
  });

  it('puts the picture on the concrete top, but not inside the plates', () => {
    const b = setup({ shadowScreen: 'base', shadowGap: -60, shadowH: 50, shadowRim: 0 }).shadow!;
    expect(wallPoint(b.geom, 0, 0)[1]).toBe(120);
    const off = b.valid.filter((x) => !x).length;
    expect(off).toBeGreaterThan(0); // plate slots
    expect(off).toBeLessThan(b.valid.length / 2);
    expect(b.scores.some((s) => !s.problem && s.match > 0.3)).toBe(true);
  });

  it('spreads the carve across the date window', () => {
    expect(windowDays({ shadowDays: 0 } as any)).toEqual([0]);
    expect(windowDays({ shadowDays: 21 } as any)).toEqual([-11, -5, 0, 5, 11]);
    const one = setup({ shadowDays: 0 }).shadow!;
    const win = setup({ shadowDays: 21 }).shadow!;
    // the window version holds up better ten days off, and is a little softer on the day
    const mean = (rep: typeof one, d: number) => rep.scores.reduce((a, s, i) => a + frameMatch(f.v, rep, i, s.time, d).match, 0) / rep.scores.length;
    expect(mean(win, 10)).toBeGreaterThan(mean(one, 10));
    expect(win.removed).toBeGreaterThan(one.removed);
  });

  it('fit tries plate layouts and picks the best, cheapest on a tie', () => {
    const p = newProject();
    p.params = { ...p.params, sunOn: true, shadowOn: true, sunMonth: '12', sunDay: 21, sunLat: 51.5, sunLon: 0, sunUtc: 0, shadowW: 120, shadowH: 80, insertOn: false, shadowDays: 0 };
    p.shadow = { frames: frames.map((_, i) => ({ id: `f${i}`, name: `F${i}`, dataUrl: `data:x${i}`, time: 11.75 + i * 0.25, hold: 0 })) };
    const assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null, shadowFrames: frames };
    const v = createFrontPipeline()(p, assets).v;
    const layouts = fitLayouts(v);
    expect(layouts.length).toBe(15);
    expect(layouts).toContainEqual({ plateCount: v.plateCount, stackHeight: v.stackHeight });
    const run = createFrontPipeline();
    const tries = layouts.slice(0, 6).map((l) => tryLayout(run, p, assets, v, l));
    for (const t of tries) expect(t.match).toBeGreaterThan(0);
    const best = bestTry(tries, v)!;
    expect(best.score).toBeGreaterThanOrEqual(Math.max(...tries.map((t) => t.score)) - 0.01);
    // a tie goes to less steel
    const tie = bestTry([{ ...tries[0], score: 0.5, params: { plateCount: 60 } }, { ...tries[0], score: 0.495, params: { plateCount: 20 } }], v)!;
    expect(tie.params.plateCount).toBe(20);
  });

  it('cleans saved frames', () => {
    expect(cleanShadow({ frames: [{ dataUrl: 'data:a', time: 30, hold: -5 }, { nope: 1 }] })).toEqual({ frames: [{ id: 'f1', name: 'Frame 1', dataUrl: 'data:a', time: 24, hold: 0 }] });
    expect(cleanShadow(null)).toBeUndefined();
  });
});
