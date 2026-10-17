import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { cutListCsv } from '../src/core/bom';
import { estimatePrice } from '../src/core/price';
import { DEFAULT_PLATE_MATERIAL } from '../src/core/params';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('shared default plate material (CR4 / mild steel)', () => {
  it('is steel for a new project, the cut list, and Chop Chop', () => {
    expect(DEFAULT_PLATE_MATERIAL).toBe('steel');
    const p = newProject();
    expect(p.params.plateMaterial ?? DEFAULT_PLATE_MATERIAL).toBe(DEFAULT_PLATE_MATERIAL);
    const m = createPipeline()(p, assets);
    expect(m.v.plateMaterial).toBe('steel');
    expect(m.bom.byMaterial[0]?.material).toBe('steel');
    const csv = cutListCsv(m.v, m.bom);
    expect(csv).toMatch(/Mild steel/);
    expect(csv).not.toMatch(/Corten steel/);
    const e = estimatePrice(m.bom, m.v.plateMaterial, m.v.thickness);
    expect(e.warnings.some((w) => /Corten/.test(w))).toBe(false);
  });

  it('keeps Corten on the Vermilion preset', () => {
    const verm = PRESETS.find((x) => x.name === 'Vermilion 40')!;
    expect(verm.params.plateMaterial).toBe('corten');
    const m = createPipeline()(applyPreset(newProject(), verm), assets);
    expect(m.v.plateMaterial).toBe('corten');
  });
});
