// Master size multiplies the real part geometry (and the exported DXF), and the
// price has to follow. The £55 minimum can pin a very small Vermilion; from
// 0.8× up the estimate has to rise at every step.
import { describe, expect, it } from 'vitest';
import { partDxf } from '../src/core/exporters';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { estimateMix } from '../src/core/price';
import { applyPreset, newProject, PRESETS } from '../src/core/project';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const SCALES = [0.8, 0.9, 1, 1.1, 1.5, 2];

function vermilion(scale: number) {
  const preset = PRESETS.find((p) => p.name === 'Vermilion 40')!;
  const project = applyPreset(newProject(), preset);
  project.params = { ...project.params, masterScale: String(scale), plateMaterial: 'steel' };
  return createPipeline()(project, assets);
}

/** Bounding box of the CUT layer (the outline a laser follows), in mm. */
function dxfCutSize(text: string): { w: number; h: number } {
  const lines = text.split(/\r?\n/);
  let layer = '';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const val = lines[i + 1].trim();
    if (code === '8') layer = val;
    else if (layer === 'CUT' && (code === '10' || code === '11')) {
      const x = Number(val);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    } else if (layer === 'CUT' && (code === '20' || code === '21')) {
      const y = Number(val);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { w: maxX - minX, h: maxY - minY };
}

describe('master size and the Chop Chop estimate', () => {
  it('raises the Vermilion price at every step from 0.8× to 2×, and the DXF scales with it', { timeout: 60_000 }, () => {
    const at1 = vermilion(1);
    const part1 = at1.sliced.parts[0];
    const dxf1 = dxfCutSize(partDxf(part1, at1.v));
    const w1 = part1.bbox.maxX - part1.bbox.minX;
    const h1 = part1.bbox.maxY - part1.bbox.minY;
    let prev = 0;
    for (const scale of SCALES) {
      const model = scale === 1 ? at1 : vermilion(scale);
      const est = estimateMix(model.bom, model.v.thickness);
      const part = model.sliced.parts[0];
      const w = part.bbox.maxX - part.bbox.minX;
      const h = part.bbox.maxY - part.bbox.minY;
      const dxf = dxfCutSize(partDxf(part, model.v));
      console.log(`scale ${scale}: £${est.net.toFixed(2)} ex VAT, part ${w.toFixed(1)}×${h.toFixed(1)} mm, dxf ${dxf.w.toFixed(1)}×${dxf.h.toFixed(1)} mm, base ${model.v.baseLength}`);
      expect(est.net).toBeGreaterThan(prev);
      prev = est.net;
      expect(model.v.baseLength).toBeCloseTo(800 * scale, 6);
      expect(model.v.plateCount).toBe(Math.round(40 * scale));
      expect(w / scale).toBeCloseTo(w1, 1);
      expect(Math.abs(h / scale - h1) / h1).toBeLessThan(0.04);
      expect(Math.abs(dxf.w - w)).toBeLessThan(0.5);
      expect(Math.abs(dxf.h - h)).toBeLessThan(0.5);
      expect(Math.abs(dxf.w / scale - dxf1.w)).toBeLessThan(1);
    }
  });

  it('holds a very small Vermilion on the £55 minimum', { timeout: 30_000 }, () => {
    for (const scale of [0.25, 1 / 3]) {
      const model = vermilion(scale);
      const est = estimateMix(model.bom, model.v.thickness);
      expect(est.subtotal).toBeLessThan(55);
      expect(est.net).toBe(55);
      expect(est.lines.some((l) => l.label === 'Minimum order charge')).toBe(true);
    }
  });
});
