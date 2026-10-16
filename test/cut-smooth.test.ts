import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { roundFloor } from '../src/core/slicer';
import type { Gray } from '../src/core/image';

const D = 0.5;
// a floor profile from [width mm, height] pieces
const floor = (...pieces: [number, number][]) => pieces.flatMap(([w, h]) => new Array<number>(Math.round(w / D)).fill(h));
const at = (g: number[], mm: number) => g[Math.round(mm / D)];

describe('rounding a carved floor', () => {
  it('fillets the foot of each wall and leaves a wide floor alone', () => {
    const g = floor([60, 100]);
    const out = roundFloor(g, D, 5, true, true);
    expect(at(out, 30)).toBeCloseTo(100, 6); // middle untouched
    expect(at(out, 0)).toBeCloseTo(105, 1); // quarter circle up into the wall
    expect(at(out, 5)).toBeCloseTo(100, 1);
  });

  it('keeps a slot narrower than the ball open, with a round bottom', () => {
    // 6 mm slot, 20 deep, in a 10 mm rounding
    const g = floor([30, 100], [6, 80], [30, 100]);
    const out = roundFloor(g, D, 10, false, false);
    expect(Math.min(...out.slice(Math.round(30 / D), Math.round(36 / D)))).toBeLessThan(81); // not filled over
    expect(Math.max(...out)).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('keeps a tower narrower than the ball standing, with a round top', () => {
    const g = floor([30, 80], [6, 100], [30, 80]);
    const out = roundFloor(g, D, 10, false, false);
    expect(Math.max(...out)).toBeGreaterThan(99); // not flattened into a lump
    expect(Math.min(...out)).toBeGreaterThanOrEqual(80 - 1e-9); // never cuts below the floor
  });

  it('turns a low step into a gentle S instead of a vertical riser', () => {
    const g = floor([30, 100], [30, 98]);
    const out = roundFloor(g, D, 10, false, false);
    for (let j = 1; j < out.length; j++) expect(out[j - 1] - out[j]).toBeLessThan(1); // no cliff left
  });
});

// a busy picture: overlapping blobs of every tone plus grain
function busy(seed: number, w = 200, h = 120): Gray {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const blobs = Array.from({ length: 40 }, () => [rnd() * w, rnd() * h, 3 + rnd() * 18, rnd()]);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (const [bx, by, r, d] of blobs) if (Math.hypot(x - bx, y - by) < r) v = Math.min(v, d);
      v += (rnd() - 0.5) * 0.15 + 0.2 * Math.sin(x / 3) * Math.sin(y / 5);
      data[y * w + x] = Math.max(0, Math.min(1, v));
    }
  return { w, h, data };
}

describe('cut edge smoothing on a busy top impression', () => {
  for (const [steps, r] of [['6', '15'], ['0', '8'], ['3', '2']]) {
    it(`stays cuttable (${steps} steps, ${r} mm)`, () => {
      const p = newProject();
      p.params = { ...p.params, insShape: 'none', imgTopMode: 'carve', imgSmooth: '0', topDepth: '40', topSteps: steps, cutSmooth: r, erosionAmp: '15' };
      const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: busy(3), insMesh: null, srcMesh: null });
      expect(m.issues.filter((i) => i.severity !== 'info').map((i) => i.message)).toEqual([]);
      // the carve never floats material or splits a plate
      expect(m.sliced.plates.every((pl) => pl.parts.length <= 1)).toBe(true);
    });
  }
});
