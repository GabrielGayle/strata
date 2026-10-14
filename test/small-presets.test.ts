import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const small = PRESETS.filter((p) => p.small);

describe('small presets', () => {
  it('has a few', () => expect(small.length).toBeGreaterThanOrEqual(3));

  for (const preset of small) {
    it(`${preset.name} fits under 10 cm and is cuttable`, () => {
      const m = createPipeline()(applyPreset(newProject(), preset), assets);
      const v = m.v;
      expect(m.ev.clamped).toEqual({});
      expect(m.ev.errors).toEqual({});
      expect(Math.max(v.baseLength, v.baseWidth)).toBeLessThanOrEqual(100);
      const top = Math.max(...m.sliced.parts.map((p) => p.bbox.maxY));
      const insTop = m.insert ? v.insY + v.insHeight : 0;
      expect(v.baseHeight + top).toBeLessThanOrEqual(100);
      expect(insTop).toBeLessThanOrEqual(100);
      expect(m.sliced.parts.length).toBeGreaterThan(0);
      const errors = m.issues.filter((i) => i.severity === 'error');
      expect(errors.map((e) => e.message)).toEqual([]);
      const warns = m.issues.filter((i) => i.severity === 'warn');
      if (warns.length) console.log(preset.name, warns.slice(0, 6).map((w) => `${w.partId}: ${w.message}`));
      // cast in with a real anchor hole and a real concrete floor
      expect(v.baseHeight - v.embedDepth).toBeGreaterThanOrEqual(5);
      expect(m.sliced.parts.every((p) => p.anchored)).toBe(true);
      expect(m.nested.unplaced).toEqual([]);
    });
  }

  it('Master size can now shrink the default piece below 10 cm without clamping the base', () => {
    const p = newProject();
    p.params = { ...p.params, masterScale: '0.1' };
    const m = createPipeline()(p, assets);
    expect(m.v.baseLength).toBeCloseTo(80);
    expect(m.ev.clamped.baseLength).toBeUndefined();
    expect(m.ev.clamped.baseWidth).toBeUndefined();
  });

  it('warns when the base floor is thin or the tab too shallow for anchors', () => {
    const p = newProject();
    p.params = { ...p.params, baseHeight: '12', embedDepth: '9', anchorDia: '6' };
    const m = createPipeline()(p, assets);
    const msgs = m.issues.map((i) => i.message);
    expect(msgs.some((t) => t.includes('of concrete under the plates'))).toBe(true);
    expect(msgs.some((t) => t.includes('too shallow'))).toBe(true);
  });
});
