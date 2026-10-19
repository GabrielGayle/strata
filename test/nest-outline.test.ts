import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { depthToGray } from '../src/core/depth';
import { materialOf } from '../src/core/appearance';
import { createFrontPipeline, createPipeline, nestGroupsOf, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, serialize, type Project } from '../src/core/project';
import { betterNest, nest, nestBoxes, nestFingerprint, nestMismatch, nestSheetArea, placeTransform, type NestResult, type SavedNest } from '../src/core/nest';
import { nestClearanceProblems } from '../src/core/nestCheck';
import { pointInPath } from '../src/core/geom2d';

const FIXTURE = 'test/fixtures/projects/buttermere-terrarium-77.strata.json';
const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function buttermere(): { project: Project; assets: Assets } {
  const project = deserialize(readFileSync(FIXTURE, 'utf8'));
  return { project, assets: { ...none, topImg: depthToGray(project.images.top!.depth!) } };
}

function groupsOf(project: Project, assets: Assets) {
  const f = createFrontPipeline()(project, assets);
  const v = f.v;
  return { f, v, groups: nestGroupsOf(f.sliced, String(v.plateMaterial), (k) => materialOf(project.appearance, k, String(v.plateMaterial))) };
}

describe('outline nest', () => {
  it('nests the Buttermere plates in at least 15% less sheet than bounding boxes, keeping the gap', () => {
    const { project, assets } = buttermere();
    const { f, v, groups } = groupsOf(project, assets);
    const items = groups[0].items;
    const boxes = { ...nestBoxes(items, v.sheetW, v.sheetH, v.partSpacing), spacing: v.partSpacing };
    const local = nest(items, v.sheetW, v.sheetH, v.partSpacing);
    const tight = nest(items, v.sheetW, v.sheetH, v.partSpacing, { maxTries: 24, seed: 7 });
    expect(local.unplaced).toEqual([]);
    expect(local.method).toBe('outline');
    expect(nestSheetArea(local)).toBeLessThan(nestSheetArea(boxes) * 0.85);
    expect(nestSheetArea(tight)).toBeLessThanOrEqual(nestSheetArea(local));
    for (const r of [local, tight]) {
      expect(nestMismatch(groups, r)).toBeNull();
      expect(nestClearanceProblems(f.sliced.parts, r, v.partSpacing)).toEqual([]);
    }
  }, 120_000);

  it('the clearance check catches parts packed tighter than the gap', () => {
    const { project, assets } = buttermere();
    const { f, v, groups } = groupsOf(project, assets);
    const touching = nest(groups[0].items, v.sheetW, v.sheetH, 0);
    expect(nestClearanceProblems(f.sliced.parts, touching, 6).some((p) => /closer than 6 mm/.test(p))).toBe(true);
  }, 120_000);

  it('turns a part and its holes together', () => {
    const { project, assets } = buttermere();
    const { f, v, groups } = groupsOf(project, assets);
    const r = nest(groups[0].items, v.sheetW, v.sheetH, v.partSpacing);
    const byId = new Map(f.sliced.parts.map((p) => [p.id, p]));
    const turns = new Set<number>();
    let holes = 0;
    for (const s of r.sheets)
      for (const pl of s.placements) {
        turns.add(pl.turn ?? 0);
        const p = byId.get(pl.id)!;
        const tf = placeTransform(p.bbox, pl);
        const outer = p.shape[0].outer.map(tf);
        for (const h of p.shape[0].holes) {
          const hp = h.map(tf);
          const c: [number, number] = [hp.reduce((a, q) => a + q[0], 0) / hp.length, hp.reduce((a, q) => a + q[1], 0) / hp.length];
          expect(pointInPath(c, outer)).toBe(true);
          holes++;
        }
      }
    // the pairs are a plate and a plate turned 180°
    expect(turns.has(2) || turns.has(3)).toBe(true);
    expect(holes).toBeGreaterThan(0);
  }, 120_000);

  it('is never worse than the bounding-box nest', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, w: 260, h: 300 + (i % 5) * 10, area: 260 * 300 }));
    const boxes = { ...nestBoxes(items, 2500, 1250, 6), spacing: 6 };
    const withOutlines = items.map((it) => ({ ...it, outline: [[[0, 0], [it.w, 0], [it.w, it.h], [0, it.h]] as [number, number][]], minX: 0, minY: 0 }));
    const r = nest(withOutlines, 2500, 1250, 6);
    expect(betterNest(boxes, r)).toBe(false);
  });

  it('repeats a budgeted nest exactly from its seed', () => {
    const { project, assets } = buttermere();
    const { v, groups } = groupsOf(project, assets);
    const a = nest(groups[0].items, v.sheetW, v.sheetH, v.partSpacing, { maxTries: 10, seed: 3 });
    const b = nest(groups[0].items, v.sheetW, v.sheetH, v.partSpacing, { maxTries: 10, seed: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 120_000);
});

describe('saved nest', () => {
  function saved(project: Project, assets: Assets, r: NestResult): SavedNest {
    const { v, groups } = groupsOf(project, assets);
    return { kind: 'nest', fingerprint: nestFingerprint(groups, v.sheetW, v.sheetH, v.partSpacing), result: r, budget: 'default' };
  }

  it('is used while the parts match it, and dropped when they change', () => {
    const project = newProject();
    const m = createPipeline()(project, none);
    // a different (worse) nest, so it is plain which one the pipeline used
    const { groups, v } = groupsOf(project, none);
    const boxes = { ...nestBoxes(groups[0].items, v.sheetW, v.sheetH, v.partSpacing), spacing: v.partSpacing, method: 'box' as const };
    const withNest: Project = { ...project, nest: saved(project, none, boxes) };
    const m2 = createPipeline()(withNest, none);
    expect(m2.nested).toEqual({ ...withNest.nest!.result, source: 'saved' });
    expect(m2.bom.partCount).toBe(m.bom.partCount);
    // survives a save and load
    const back = deserialize(serialize(withNest));
    expect(back.nest?.fingerprint).toBe(withNest.nest!.fingerprint);
    expect(createPipeline()(back, none).nested.sheets.length).toBe(boxes.sheets.length);
    // a different sheet size is a different nest
    const changed: Project = { ...withNest, params: { ...withNest.params, sheetW: '2400' } };
    expect(createPipeline()(changed, none).nested.source).toBeUndefined();
  });

  it('is refused when it misses a part', () => {
    const project = newProject();
    const { groups, v } = groupsOf(project, none);
    const r = nest(groups[0].items, v.sheetW, v.sheetH, v.partSpacing);
    const short = { ...r, sheets: r.sheets.map((s, i) => (i === 0 ? { ...s, placements: s.placements.slice(1) } : s)) };
    expect(nestMismatch(groups, short)).toMatch(/parts/);
    const withNest: Project = { ...project, nest: saved(project, none, short) };
    const m = createPipeline()(withNest, none);
    expect(m.nested.source).toBeUndefined();
    expect(m.nested.sheets.reduce((a, s) => a + s.placements.length, 0)).toBe(groups[0].items.length);
  });
});
