import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';

function run(params: Record<string, string>) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', ...params };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
}

// stack-axis position of each plate's centre plane
const centres = (m: ReturnType<typeof run>) => m.sliced.plates.map((p) => p.def.plane.origin[0] * p.def.plane.normal[0] + p.def.plane.origin[2] * p.def.plane.normal[2]);

describe('plate spacing', () => {
  it('fixed gap sets the clear space between plate faces', () => {
    const m = run({ spacingMode: 'gapCount', plateGap: '12', thickness: '3', plateCount: '9' });
    expect(m.v.pitch).toBeCloseTo(15, 6);
    expect(m.ev.overrides.pitch).toBeTruthy();
    const c = centres(m);
    expect(c.length).toBe(9);
    for (let i = 1; i < c.length; i++) expect(c[i] - c[i - 1] - m.v.thickness).toBeCloseTo(12, 6);
  });

  it('keeps the arrangement centred on the base', () => {
    for (const sliceAxis of ['length', 'width']) {
      const m = run({ spacingMode: 'gapCount', plateGap: '7', plateCount: '6', sliceAxis });
      const c = centres(m);
      expect(c[0] + c[c.length - 1]).toBeCloseTo(0, 6);
    }
  });

  it('fill base fits as many plates as the end margins allow', () => {
    const m = run({ spacingMode: 'gap', plateGap: '17', thickness: '3', baseLength: '800', endMargin: '40' });
    expect(m.v.plateCount).toBe(Math.floor(720 / 20) + 1);
    expect(m.ev.overrides.plateCount).toBeTruthy();
    const c = centres(m);
    expect(c[c.length - 1] - c[0]).toBeLessThanOrEqual(720 + 1e-6);
    expect(c[0] + c[c.length - 1]).toBeCloseTo(0, 6);
  });

  it('warns when a set count with a fixed gap overhangs the base', () => {
    const m = run({ spacingMode: 'gapCount', plateGap: '30', thickness: '3', plateCount: '40', baseLength: '800' });
    expect(m.sliced.warnings.some((w) => w.includes('overhang'))).toBe(true);
  });

  it('leaves the default spread-over-base spacing alone', () => {
    const m = run({});
    expect(m.v.spacingMode).toBe('fit');
    expect(m.ev.overrides.pitch).toBeUndefined();
    expect(m.v.pitch).toBeCloseTo((m.v.stackLength - 2 * m.v.endMargin) / (m.v.plateCount - 1), 6);
    expect(m.sliced.warnings.some((w) => w.includes('overhang'))).toBe(false);
  });
});
