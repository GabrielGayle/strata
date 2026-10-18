import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { depthToGray } from '../src/core/depth';
import { createPipeline } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';
import { curveAudit } from './curve/audit';

// Buttermere from Terrarium tiles, 77 plates of 1.5 mm steel (rebuild with scripts/curve-fixture.ts).
const FIXTURE = 'test/fixtures/projects/buttermere-terrarium-77.strata.json';

describe('map plate-top curves (curve audit, phase 1)', () => {
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

  it('keeps the coarse profile while dragging', async () => {
    const { createFrontPipeline, PREVIEW_SAMPLE_STEP } = await import('../src/core/pipeline');
    const project = deserialize(readFileSync(FIXTURE, 'utf8'));
    const top = depthToGray(project.images.top!.depth!);
    const f = createFrontPipeline({ preview: true })(project, { sideImg: null, frontImg: null, topImg: top, insMesh: null, srcMesh: null });
    expect(f.v.curveStep).toBe(PREVIEW_SAMPLE_STEP);
  }, 60_000);
});
