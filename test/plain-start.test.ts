import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PLAIN_A5, PRESETS, startingProject, type Project } from '../src/core/project';
import { buildPackHtml } from '../src/core/buildPack';
import { buildZip } from '../src/core/exporters';
import { estimateMix } from '../src/core/price';
import { GROUP_IDLE } from '../src/core/params';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const run = (p: Project) => createPipeline()(p, assets);
const withParams = (p: Project, params: Project['params']) => ({ ...p, params: { ...p.params, ...params } });

describe('plain A5 starting preset', { timeout: 30_000 }, () => {
  it('is first in the Presets menu and is what a new project opens as', () => {
    expect(PRESETS[0]).toBe(PLAIN_A5);
    const p = startingProject();
    expect(p.name).toBe('Plain A5 base');
    expect(p.pour).toHaveLength(1);
    // old saves and files still read against the full default
    expect(newProject().name).toBe('Vermilion 40');
  });

  it('is an A5 slab of plain concrete with no plates, no insert and no fit issues', () => {
    const m = run(startingProject());
    expect(m.v.baseLength).toBe(210);
    expect(m.v.baseWidth).toBe(148);
    expect(m.ev.errors).toEqual({});
    expect(m.ev.clamped).toEqual({});
    expect(m.sliced.plates).toEqual([]);
    expect(m.sliced.parts).toEqual([]);
    expect(m.insert).toBeFalsy();
    expect(m.issues.map((i) => `${i.severity}: ${i.message}`)).toEqual([]);
    expect(m.pour.rows).toHaveLength(1);
    expect(m.pour.mismatch).toBeCloseTo(0);
    expect(GROUP_IDLE.Strata!(m.v)).toMatch(/Plates is off/);
  });

  it('build pack, zip and price work with nothing to cut', () => {
    const p = startingProject();
    const m = run(p);
    const html = buildPackHtml(p, m, { date: new Date(2026, 9, 19) });
    expect(html).toContain('data-plate-count="0"');
    expect(html).toContain('Concrete base only: no plates');
    expect(html).toContain('No sheet metal');
    expect(html).toContain('<section id="pour">');
    const zip = unzipSync(buildZip(m, p));
    expect(JSON.parse(strFromU8(zip['manifest.json'])).plateCount).toBe(0);
    expect(Object.keys(zip).filter((k) => k.startsWith('plates/'))).toEqual([]);
    const price = estimateMix(m.bom, m.v.thickness);
    expect(Number.isFinite(price.total)).toBe(true);
    expect(m.bom.concreteBase).toBeGreaterThan(0);
  });

  for (const [name, on] of [
    ['Plates', { platesOn: true }],
    ['Plates + Strata', { platesOn: true, strataOn: true }],
    ['Plates + Strata + Insert', { platesOn: true, strataOn: true, insertOn: true }],
    ['Insert alone', { insertOn: true }],
  ] as const) {
    it(`switching ${name} back on gives a clean piece`, () => {
      const m = run(withParams(startingProject(), on));
      expect(m.ev.errors).toEqual({});
      expect(m.ev.clamped).toEqual({});
      if ('platesOn' in on) expect(m.sliced.plates.length).toBe(16);
      if ('insertOn' in on) expect(m.insert).toBeTruthy();
      expect(m.issues.filter((i) => i.severity === 'error').map((i) => `${i.partId}: ${i.message}`)).toEqual([]);
      const warns = m.issues.filter((i) => i.severity === 'warn').map((i) => `${i.partId}: ${i.message}`);
      expect(warns).toEqual([]);
    });
  }

  it('other presets switch plates, strata and insert back on', () => {
    const v = applyPreset(startingProject(), PRESETS.find((x) => x.name === 'Vermilion 40')!);
    expect(v.params.platesOn).toBe(true);
    expect(v.params.insertOn).toBe(true);
    expect(v.params.strataOn).toBe(true);
  });
});
