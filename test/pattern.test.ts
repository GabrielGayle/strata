import { describe, expect, it } from 'vitest';
import { makePattern, patternSize, PATTERN_PRESETS, randomLayer, renderPattern } from '../src/core/pattern';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { topAt } from '../src/core/slicer';

const at = (g: { w: number; h: number; data: Float32Array }, fx: number, fy: number) => g.data[Math.floor(fy * (g.h - 1)) * g.w + Math.floor(fx * (g.w - 1))];

describe('pattern graphics', () => {
  it('draws a single filled circle dark in the middle, white outside', () => {
    const g = renderPattern(makePattern([{ shape: 'circle', tiling: 'single', size: 0.5 }]), 101, 101);
    expect(at(g, 0.5, 0.5)).toBe(0);
    expect(at(g, 0.05, 0.05)).toBe(1);
    expect(at(g, 0.5, 0.2)).toBe(1); // radius 0.5 of the half-height ends at 0.25 of the frame
  });

  it('repeats a grid motif in every cell', () => {
    const g = renderPattern(makePattern([{ shape: 'square', tiling: 'grid', cells: 4, size: 0.5 }]), 160, 160);
    // cells are centred on the frame centre so symmetry and repeats line up
    for (const c of [0.25, 0.5, 0.75]) expect(at(g, c, c)).toBe(0);
    expect(at(g, 0.375, 0.375)).toBe(1); // cell corners stay white
  });

  it('kaleidoscope output is mirror symmetric', () => {
    const g = renderPattern(randomLayerSpec(), 120, 120);
    let diff = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) diff += Math.abs(g.data[y * 120 + x] - g.data[y * 120 + 119 - x]);
    expect(diff / (120 * 120)).toBeLessThan(0.02);
  });

  it('soft edges grade from the rim to full darkness inside', () => {
    const g = renderPattern(makePattern([{ shape: 'circle', tiling: 'single', size: 0.8, edge: 'soft', softness: 1 }]), 101, 101);
    expect(at(g, 0.5, 0.5)).toBeLessThan(0.05);
    const mid = at(g, 0.5, 0.2);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
  });

  it('text strokes darken the centre line of a word', () => {
    const g = renderPattern(makePattern([{ shape: 'text', text: 'I', tiling: 'single', size: 0.8, outline: 0.3 }]), 101, 101);
    expect(at(g, 0.5, 0.5)).toBe(0);
    expect(at(g, 0.1, 0.5)).toBe(1);
  });

  it('every preset renders a mix of dark and light', () => {
    for (const p of PATTERN_PRESETS) {
      const spec = p.spec();
      const { w, h } = patternSize(spec, 80);
      const g = renderPattern(spec, w, h);
      const mean = g.data.reduce((a, b) => a + b, 0) / g.data.length;
      expect(mean, p.name).toBeGreaterThan(0.1);
      expect(mean, p.name).toBeLessThan(0.95);
    }
  });

  it('feeds the top impression like an uploaded image', () => {
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgTopMode: 'carve', topDepth: '20', topSteps: '1', imgSmooth: '0', imgContrast: '1', topScale: '1' };
    const topImg = renderPattern(makePattern([{ shape: 'circle', tiling: 'single', size: 0.6 }], 2), 120, 60);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg, insMesh: null, srcMesh: null });
    const plates = m.sliced.plates;
    const mid = plates[Math.floor(plates.length / 2)].parts[0];
    expect(topAt(mid.shape, 0)).toBeCloseTo(m.v.stackHeight - 20, 1);
  });
});

function randomLayerSpec() {
  return makePattern([{ ...randomLayer(5), symmetry: 'kaleido', folds: 6, tiling: 'grid', rotate: 0 }]);
}
