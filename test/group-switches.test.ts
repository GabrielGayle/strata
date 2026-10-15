import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { GROUP_SWITCHES, GROUPS, PARAM_MAP, PARAMS, evaluateParams } from '../src/core/params';

function run(params: Record<string, string | boolean>) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', ...params };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
}

const tops = (m: ReturnType<typeof run>) => m.sliced.plates.map((pl) => Math.max(...pl.parts[0].shape[0].outer.map((q) => q[1])));

describe('group switches', () => {
  it('every switch is a toggle in its own group and every forced value is a real parameter', () => {
    for (const [g, sw] of Object.entries(GROUP_SWITCHES)) {
      expect(GROUPS).toContain(g);
      expect(PARAM_MAP[sw!.id]?.kind).toBe('toggle');
      expect(PARAM_MAP[sw!.id].group).toBe(g);
      for (const id of Object.keys(sw!.forces ?? {})) expect(PARAM_MAP[id], id).toBeTruthy();
    }
  });

  it('strata off gives flat plates at the plate height and keeps the erosion settings', () => {
    const on = run({ erosionAmp: '60', crest: '40' });
    const off = run({ erosionAmp: '60', crest: '40', strataOn: false });
    expect(off.v.erosionAmp).toBe(0);
    expect(off.v.crest).toBe(0);
    const t = tops(off);
    for (const y of t) expect(y).toBeCloseTo(off.v.stackHeight, 0);
    expect(Math.max(...tops(on)) - Math.min(...tops(on))).toBeGreaterThan(5);
    // nothing is written over: switching back on restores the same model
    const back = evaluateParams({ ...newProject().params, erosionAmp: '60', strataOn: true });
    expect(back.values.erosionAmp).toBe(60);
  });

  it('bracing, support, image and tuning switches turn their features off', () => {
    const ev = evaluateParams({
      ...newProject().params,
      rodsOn: true, spacerMode: 'both', bracingOn: false,
      supportMode: 'radial', supportOn: false,
      imgTopMode: 'carve', imgFit: 'width', imageOn: false,
      tuneMode: 'scale', tuneOn: false,
    });
    expect(ev.values.rodsOn).toBe(false);
    expect(ev.values.spacerMode).toBe('off');
    expect(ev.values.supportMode).toBe('off');
    expect(ev.values.imgTopMode).toBe('off');
    expect(ev.overrides).toEqual({});
    expect(ev.values.tuneMode).toBe('off');
  });

  it('switched-off bracing leaves no rods or spacer parts', () => {
    const on = run({ anchorHoles: '0', rodsOn: true, spacerMode: 'cross' });
    const off = run({ anchorHoles: '0', rodsOn: true, spacerMode: 'cross', bracingOn: false });
    expect(on.sliced.brace?.rods?.rods.length).toBeGreaterThan(0);
    expect(off.sliced.brace?.rods?.rods.length ?? 0).toBe(0);
    const holes = (m: ReturnType<typeof run>) => m.sliced.parts.filter((p) => p.family === 'P').reduce((n, p) => n + p.shape[0].holes.length, 0);
    expect(holes(off)).toBe(0);
    expect(off.sliced.parts.length).toBeLessThan(on.sliced.parts.length);
  });

  it('all margins live together in the Margins group, after Image', () => {
    const margins = PARAMS.filter((p) => /margin/i.test(p.id)).map((p) => p.group);
    expect(new Set(margins)).toEqual(new Set(['Margins']));
    expect(GROUPS.indexOf('Margins')).toBe(GROUPS.indexOf('Image') + 1);
    expect(PARAM_MAP.stackHeight.group).toBe('Plates');
  });
});
