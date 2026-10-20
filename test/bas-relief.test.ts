import { describe, expect, it } from 'vitest';
import { defaultDepthSettings, depthToGray, type DepthData } from '../src/core/depth';
import { basRelief, featherMatte, integrate } from '../src/core/basRelief';

const W = 160;
const H = 100;

/** A body (dome) with a hand (bar) lying on it: metric depth with a cut-out, like Depth Pro sends. */
function figure(): DepthData {
  const metres = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dx = (x - 80) / 55, dy = (y - 50) / 35;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) {
        metres[i] = 2.5;
        continue;
      }
      let h = 0.04 + 0.08 * Math.sqrt(1 - d2); // standing proud of the background: a wall at the edge
      if (Math.abs(y - 48) < 7 && x > 50 && x < 115) h += 0.06; // the hand: a sharp step
      metres[i] = 1.2 - h;
      mask[i] = 255;
    }
  const minM = 1.2 - 0.18, maxM = 2.5;
  const q = new Uint8Array(W * H * 2);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(1 + ((metres[i] - minM) / (maxM - minM)) * 65534);
    q[i * 2] = v & 255;
    q[i * 2 + 1] = v >> 8;
  }
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
  const d = { w: W, h: H, minM, maxM, nearM: minM, farM: 1.2, data: b64(q), mask: b64(mask) };
  return { ...d, settings: { ...defaultDepthSettings(d, true), spacing: 'linear', resolution: 160 } };
}

/** Steepest change between neighbours along one row, in grey levels. */
function maxStep(g: Float32Array, row: number) {
  let m = 0;
  for (let x = 1; x < W; x++) m = Math.max(m, Math.abs(g[row * W + x] - g[row * W + x - 1]));
  return m;
}

describe('bas-relief', () => {
  it('integrates a gradient field back to the surface it came from', () => {
    const w = 24, h = 17;
    const z = new Float32Array(w * h).map((_, i) => Math.sin((i % w) / 4) + Math.cos(Math.floor(i / w) / 3));
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        gx[i] = x < w - 1 ? z[i + 1] - z[i] : 0;
        gy[i] = y < h - 1 ? z[i + w] - z[i] : 0;
      }
    const r = integrate(gx, gy, w, h);
    const off = r[0] - z[0];
    for (let i = 0; i < w * h; i++) expect(r[i] - off).toBeCloseTo(z[i], 6);
  });

  it('is off by default and leaves old projects alone', () => {
    const d = figure();
    const a = depthToGray(d);
    const b = depthToGray(d, { ...d.settings, squash: 0, detail: 2 });
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it('turns the walls at the hand and the figure edge into ramps', () => {
    const d = figure();
    const plain = depthToGray(d);
    const soft = depthToGray(d, { ...d.settings, squash: 0.8 });
    // row 42 crosses the figure edge and the hand's edge
    expect(maxStep(plain.data, 42)).toBeGreaterThan(0.15);
    expect(maxStep(soft.data, 42)).toBeLessThan(maxStep(plain.data, 42) * 0.4);
    // still a relief: the middle stands well above the background, which stays flat
    const mid = soft.data[50 * W + 80];
    expect(mid).toBeGreaterThan(0.6); // inverted: near = light
    expect(soft.data[5 * W + 5]).toBeLessThan(0.02);
    expect(soft.data[95 * W + 150]).toBeLessThan(0.02);
  });

  it('cuts an incised outline along the jumps', () => {
    const d = figure();
    const soft = depthToGray(d, { ...d.settings, squash: 0.8 });
    const lined = depthToGray(d, { ...d.settings, squash: 0.8, outline: 0.15 });
    // just inside the hand's top edge (y 41)
    let dip = 0;
    for (let x = 60; x < 105; x++) dip = Math.max(dip, soft.data[41 * W + x] - lined.data[41 * W + x]);
    expect(dip).toBeGreaterThan(0.05);
    // away from any edge the surface is untouched
    expect(Math.abs(soft.data[62 * W + 80] - lined.data[62 * W + 80])).toBeLessThan(0.01);
  });

  it('feathers the cut-out so the figure rolls down instead of stopping at a wall', () => {
    const d = figure();
    const plain = depthToGray(d);
    const feathered = depthToGray(d, { ...d.settings, feather: 6 });
    expect(maxStep(feathered.data, 70)).toBeLessThan(maxStep(plain.data, 70) * 0.6);
    expect(feathered.data[50 * W + 80]).toBeCloseTo(plain.data[50 * W + 80], 3);
  });

  it('feather never grows the cut-out past its edge', () => {
    const k = new Float32Array(20 * 20).map((_, i) => (i % 20 > 9 ? 1 : 0));
    const f = featherMatte(k, 20, 20, 4);
    for (let i = 0; i < k.length; i++) expect(f[i]).toBeLessThanOrEqual(k[i]);
    expect(f[10 * 20 + 19]).toBeCloseTo(1, 2);
  });

  it('works without a cut-out (background found from the lowest heights)', () => {
    const w = 64, h = 40;
    const data = new Float32Array(w * h).map((_, i) => {
      const x = i % w, y = Math.floor(i / w);
      return Math.hypot(x - 32, y - 20) < 12 ? 0.9 : 0;
    });
    const out = basRelief(data, w, h, { squash: 0.8, detail: 1, outline: 0, outlineWidth: 1.5 });
    expect(out[0]).toBeLessThan(0.03);
    expect(out[20 * w + 32]).toBeGreaterThan(0.8);
  });

  it('runs a 512 × 341 photo depth in well under two seconds', () => {
    const w = 512, h = 341;
    const data = new Float32Array(w * h).map((_, i) => Math.max(0, Math.sin((i % w) / 40) * Math.cos(Math.floor(i / w) / 30)));
    const t = performance.now();
    basRelief(data, w, h, { squash: 0.7, detail: 1.8, outline: 0.06, outlineWidth: 1.5 });
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
