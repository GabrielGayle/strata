import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { auditScenario } from '../src/core/buildPackAudit';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

/** Default run stays small. Full 120-config fuzz: `STRATA_PACK_FUZZ=1 npx tsx tools/run-buildpack-harness.ts`. */
const FUZZ = process.env.STRATA_PACK_FUZZ === '1' ? 120 : 0;

describe('build pack plate harness', () => {
  it('finds no missing plate files in representative scenarios', () => {
    const cases: { name: string; p: ReturnType<typeof newProject> }[] = [];

    const row = newProject();
    row.params = { ...row.params, plateCount: '8', insShape: 'none', anchorHoles: '0' };
    cases.push({ name: 'row-8', p: row });

    const mapFlat = newProject();
    mapFlat.params = { ...mapFlat.params, sliceMode: 'flat', plateCount: '6', insShape: 'none' };
    cases.push({ name: 'flat-6', p: mapFlat });

    const waffle = newProject();
    waffle.params = { ...waffle.params, sliceMode: 'waffle', plateCount: '6', crossCount: '3', insShape: 'none' };
    cases.push({ name: 'waffle-6', p: waffle });

    for (let i = 0; i < FUZZ; i++) {
      const p = newProject();
      p.params = {
        ...p.params,
        plateCount: String(6 + (i % 8)),
        thickness: ['0.5', '1', '3'][i % 3],
        insShape: 'none',
        anchorHoles: '0',
      };
      cases.push({ name: `fuzz-${i}`, p });
    }

    for (const { name, p } of cases) {
      const m = createPipeline()(p, assets);
      const issues = auditScenario(name, m, p);
      const fileMiss = issues.filter((i) => i.kind !== 'schedule_missing_part' && i.kind !== 'angled_missing' && i.kind !== 'plan_svg_empty');
      expect(fileMiss, name).toEqual([]);
    }
  });
});
