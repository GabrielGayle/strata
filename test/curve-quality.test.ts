import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { depthToGray } from '../src/core/depth';
import { createPipeline } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';
import { curveAudit } from './curve/audit';

// Buttermere from Terrarium tiles, 77 plates of 1.5 mm steel (rebuild with scripts/curve-fixture.ts).
const FIXTURE = 'test/fixtures/projects/buttermere-terrarium-77.strata.json';

describe('map plate-top curves (curve audit)', () => {
  it('cuts smooth curves, mostly as arcs, without losing plates or the summit', () => {
    const project = deserialize(readFileSync(FIXTURE, 'utf8'));
    const top = depthToGray(project.images.top!.depth!);
    const model = createPipeline()(project, { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null });
    const r = curveAudit(model);
    expect(r.plates).toBe(77);
    expect(r.fitErrors).toBe(0);
    expect(r.medianTurnDeg).toBeLessThan(5);
    expect(r.over20Share).toBeLessThan(0.01);
    expect(r.arcs / r.entities).toBeGreaterThan(0.5);
    expect(r.arcLengthShare).toBeGreaterThan(0.5);
    // the plate nearest the summit stays within half a millimetre of it, and only a couple share the top
    expect(r.hfMaxMm - r.topMm).toBeLessThan(0.5);
    expect(r.platesAtTop).toBeLessThan(3);
  }, 60_000);

  it('phase 2: joins every arc on its neighbour\'s tangent, with no stubs between the plate ends', () => {
    const project = deserialize(readFileSync(FIXTURE, 'utf8'));
    const top = depthToGray(project.images.top!.depth!);
    const model = createPipeline()(project, { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null });
    const r = curveAudit(model);
    expect(r.plates).toBe(77);
    expect(r.fitErrors).toBe(0);
    // phase 1 left a 2.1° median and 0.9% over 20°; biarcs meet on a shared tangent
    expect(r.medianTurnDeg).toBeLessThan(0.1);
    expect(r.over1Share).toBeLessThan(0.005);
    expect(r.over20Share).toBeLessThan(0.001);
    expect(r.arcs / r.entities).toBeGreaterThan(0.9);
    expect(r.arcLengthShare).toBeGreaterThan(0.9);
    expect(r.midStubs).toBe(0);
    // the 0.5 mm minimum radius rounds peaks, but the summit stays where phase 1 had it (188.79 mm)
    expect(Math.abs(r.topMm - 188.79)).toBeLessThan(0.15);
    expect(r.platesAtTop).toBeLessThan(3);
  }, 60_000);

  it('keeps the coarse profile while dragging', async () => {
    const { createFrontPipeline, PREVIEW_SAMPLE_STEP } = await import('../src/core/pipeline');
    const project = deserialize(readFileSync(FIXTURE, 'utf8'));
    const top = depthToGray(project.images.top!.depth!);
    const f = createFrontPipeline({ preview: true })(project, { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null });
    expect(f.v.curveStep).toBe(PREVIEW_SAMPLE_STEP);
  }, 60_000);
});
