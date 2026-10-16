import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { estimateMix, withHardware } from '../src/core/price';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { chopChopCollapsedSummary } from '../src/ui/chopChopSummary';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function vermilion(scale: number) {
  const preset = PRESETS.find((p) => p.name === 'Vermilion 40')!;
  const project = applyPreset(newProject(), preset);
  project.params = { ...project.params, masterScale: String(scale), plateMaterial: 'steel' };
  return createPipeline()(project, assets);
}

describe('Chop Chop collapsed price summary', () => {
  it('includes total inc VAT and plate count', () => {
    const model = vermilion(1);
    const bom = model.bom;
    const line = chopChopCollapsedSummary(bom, model.v.thickness);
    const est = withHardware(estimateMix(bom, model.v.thickness), bom.hardware);
    expect(line).toContain('inc VAT');
    expect(line).toMatch(/£[\d,]+\.\d{2}/);
    expect(line).toMatch(/\d+ plate/);
    expect(line).toContain(Math.floor(est.total).toString());
  });

  it('updates when the cut list changes (collapsed live summary input)', () => {
    const small = vermilion(0.9);
    const large = vermilion(1.5);
    const a = chopChopCollapsedSummary(small.bom, small.v.thickness);
    const b = chopChopCollapsedSummary(large.bom, large.v.thickness);
    expect(a).not.toBe(b);
    expect(estimateMix(large.bom, large.v.thickness).total).toBeGreaterThan(estimateMix(small.bom, small.v.thickness).total);
  });

  it('truncates gracefully when the line would overflow', () => {
    const model = vermilion(1);
    const full = chopChopCollapsedSummary(model.bom, model.v.thickness, undefined, { maxLen: 200 });
    const short = chopChopCollapsedSummary(model.bom, model.v.thickness, undefined, { maxLen: 12 });
    expect(full.length).toBeGreaterThan(12);
    expect(short.length).toBeLessThanOrEqual(12);
    expect(short.endsWith('…')).toBe(true);
  });
});
