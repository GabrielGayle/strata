import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { auditScenario } from '../src/core/buildPackAudit';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('build pack plate harness', () => {
  it('finds no missing plate files in representative scenarios', () => {
    const cases: { name: string; p: ReturnType<typeof newProject> }[] = [];
    const pacey = newProject();
    pacey.params.plateCount = '94';
    pacey.params.pitch = '2.5';
    pacey.params.thickness = '0.5';
    cases.push({ name: 'pacey-thin', p: pacey });

    const mapFlat = newProject();
    mapFlat.params.sliceMode = 'flat';
    mapFlat.params.plateCount = '12';
    cases.push({ name: 'flat-12', p: mapFlat });

    const tuned = newProject();
    tuned.params.tuneOn = '1';
    tuned.params.plateCount = '28';
    cases.push({ name: 'tuned', p: tuned });

    for (const { name, p } of cases) {
      const m = createPipeline()(p, assets);
      const issues = auditScenario(name, m, p);
      const fileMiss = issues.filter((i) => i.kind !== 'schedule_missing_part' && i.kind !== 'angled_missing' && i.kind !== 'plan_svg_empty');
      expect(fileMiss, name).toEqual([]);
    }
  });
});
