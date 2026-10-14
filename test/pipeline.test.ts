import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { partDxf, sheetDxf, mouldPartDxf, unfoldDxf, buildZip } from '../src/core/exporters';
import { mkdirSync, writeFileSync } from 'node:fs';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

describe('pipeline', () => {
  it('builds the default 40-plate piece with a straight-cut fin cavity', () => {
    const compute = createPipeline();
    const t0 = performance.now();
    const m = compute(newProject(), assets);
    const ms = performance.now() - t0;
    console.log('default compute ms', ms.toFixed(0), m.stages.map((s) => `${s.name}:${s.ms.toFixed(0)}`).join(' '));
    expect(m.sliced.plates.length).toBe(40);
    expect(m.sliced.parts.length).toBeGreaterThanOrEqual(40);
    const cut = m.sliced.plates.filter((p) => p.cavity.length);
    expect(cut.length).toBeGreaterThan(10);
    const errors = m.issues.filter((i) => i.severity === 'error');
    console.log('errors', errors.map((e) => `${e.partId}:${e.message}`));
    console.log('warns', m.issues.filter((i) => i.severity === 'warn').slice(0, 8).map((e) => `${e.partId}:${e.message}`));
    expect(m.nested.sheets.length).toBeGreaterThan(0);
    expect(m.nested.unplaced).toEqual([]);
    expect(m.moulds.parts.length).toBeGreaterThan(5);
    expect(m.pour.rows.length).toBe(3);
    expect(Math.abs(m.pour.mismatch)).toBeLessThan(0.01);
    expect(m.unfolded.ok).toBe(true);
    console.log('unfold', m.unfolded.message);
    console.log('bom', JSON.stringify({ ...m.bom, rows: m.bom.rows.length, pour: m.bom.pour.length }));

    // incremental: changing kerf must not re-slice
    const p2 = newProject();
    p2.params = { ...p2.params, kerf: '0.2' };
    const m2 = compute(p2, assets);
    expect(m2.stages.find((s) => s.name === 'Slice plates')!.cached).toBe(true);

    const out = process.env.STRATA_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      for (const p of m.sliced.parts.slice(0, 40)) writeFileSync(`${out}/${p.id}.dxf`, partDxf(p, m.v));
      writeFileSync(`${out}/sheet-1.dxf`, sheetDxf(m, 0));
      for (const mp of m.moulds.parts.slice(0, 4)) writeFileSync(`${out}/${mp.id}.dxf`, mouldPartDxf(mp, m.v));
      writeFileSync(`${out}/unfold.dxf`, unfoldDxf(m.unfolded.pieces, m.v));
      writeFileSync(`${out}/bundle.zip`, buildZip(m, newProject()));
      const lw = { ...m.v, dxfMode: 'lines' };
      writeFileSync(`${out}/lines-${m.sliced.parts[20].id}.dxf`, partDxf(m.sliced.parts[20], lw));
    }
  });

  it('runs every preset', () => {
    for (const preset of PRESETS) {
      const compute = createPipeline();
      const t0 = performance.now();
      const m = compute(applyPreset(newProject(), preset), assets);
      console.log(preset.name, (performance.now() - t0).toFixed(0), 'ms', m.sliced.parts.length, 'parts', m.issues.filter((i) => i.severity === 'error').length, 'errors', m.unfolded.message);
      expect(m.sliced.parts.length).toBeGreaterThan(0);
    }
  });
});
