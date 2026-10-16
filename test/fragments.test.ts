import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { piecesTouch, resolveFragments, isSubMinimum, formatFragment, repairThinNecks, morphOpen } from '../src/core/fragments';
import { difference, rect, unionShapes, type ExPoly } from '../src/core/geom2d';
import { GABRIEL_PARAMS, sliverFrontGray, sliverSideGray } from './image-sliver-fixture';
import { assertCountsAgree } from '../src/core/counts';
import { buildPackHtml } from '../src/core/buildPack';
import { unzipSync, strFromU8 } from 'fflate';
import { buildZip } from '../src/core/exporters';

const assets = (): Assets => ({
  sideImg: sliverSideGray(),
  frontImg: sliverFrontGray(),
  topImg: null,
  insMesh: null,
  srcMesh: null,
});

function run(fragmentMode: string) {
  const p = newProject();
  p.params = { ...p.params, ...GABRIEL_PARAMS, fragmentMode };
  return createPipeline()(p, assets());
}

const parent: ExPoly = rect(0, -20, 80, 60)[0];
const sliver: ExPoly = rect(0, 59.2, 18.8, 60)[0]; // 18.8 × 0.8 mm cap, barely touching
const island: ExPoly = rect(90, 40, 91, 58)[0]; // detached 1 × 18 mm

describe('fragment resolve', () => {
  it('treats a 0.8 mm cap as sub-minimum at 3 mm', () => {
    expect(isSubMinimum(sliver, 3)).toBe(true);
    expect(isSubMinimum(parent, 3)).toBe(false);
  });

  it('merges a touching sliver into the parent', () => {
    expect(piecesTouch(parent, sliver, 0.2)).toBe(true);
    const { pieces, events } = resolveFragments([parent, sliver], {
      v: { minFragment: 3, fragmentMode: 'auto', kerf: 0.15, minPartSize: 15, thickness: 1.5 },
      plateKey: 'P2',
      plateId: 'S-03',
      anchored: (ex) => ex === parent,
    });
    expect(pieces).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('merged');
    expect(events[0].plateId).toBe('S-03');
  });

  it('drops a detached unsupported sliver', () => {
    const { pieces, events } = resolveFragments([parent, island], {
      v: { minFragment: 3, fragmentMode: 'auto', kerf: 0.15, minPartSize: 15, thickness: 1.5 },
      plateKey: 'P2',
      plateId: 'S-03',
      anchored: (ex) => ex === parent,
    });
    expect(pieces).toHaveLength(1);
    expect(events[0].action).toBe('dropped');
    expect(events[0].reason).toMatch(/unanchored|both|small/);
  });

  it('reports when Merge into parent falls back to dropping', () => {
    const { pieces, events } = resolveFragments([parent, island], {
      v: { minFragment: 3, fragmentMode: 'merge', kerf: 0.15, minPartSize: 15, thickness: 1.5 },
      plateKey: 'P2',
      plateId: 'S-03',
      anchored: (ex) => ex === parent,
    });
    expect(pieces).toHaveLength(1);
    expect(events[0].action).toBe('dropped');
    expect(events[0].mergeFallback).toBe(true);
    expect(formatFragment(events[0])).toMatch(/Merge into parent fell back to dropping/);
  });

  it('keeps fragments when asked', () => {
    const { pieces, events } = resolveFragments([parent, island], {
      v: { minFragment: 3, fragmentMode: 'keep', kerf: 0.15, minPartSize: 15, thickness: 1.5 },
      plateKey: 'P2',
      plateId: 'S-03',
      anchored: (ex) => ex === parent,
    });
    expect(pieces).toHaveLength(2);
    expect(events[0].action).toBe('kept');
  });
});

describe('thin necks (min feature)', () => {
  const dumbbell = () =>
    unionShapes(rect(0, 0, 40, 40), rect(38, 19.2, 72, 20.8), rect(70, 0, 110, 40));

  it('merge/auto widen a 1.6 mm neck so the 2 mm opening is empty', () => {
    const s = dumbbell();
    const thinBefore = difference(s, morphOpen(s, 2));
    expect(thinBefore.length).toBeGreaterThan(0);
    const merged = repairThinNecks(s, { minFeature: 2, fragmentMode: 'merge' });
    expect(difference(merged, morphOpen(merged, 2))).toHaveLength(0);
    const auto = repairThinNecks(s, { minFeature: 2, fragmentMode: 'auto' });
    expect(difference(auto, morphOpen(auto, 2))).toHaveLength(0);
  });

  it('drop opens the neck (splits the lobes) and keep leaves the thin web', () => {
    const s = dumbbell();
    const dropped = repairThinNecks(s, { minFeature: 2, fragmentMode: 'drop' });
    expect(dropped.length).toBeGreaterThan(1);
    const kept = repairThinNecks(s, { minFeature: 2, fragmentMode: 'keep' });
    expect(difference(kept, morphOpen(kept, 2)).length).toBeGreaterThan(0);
  });

  it('does not overwrite the user minFeature / minFragment', () => {
    const p = newProject();
    p.params = { ...p.params, ...GABRIEL_PARAMS, fragmentMode: 'auto', minFeature: '3', minFragment: '9' };
    const m = createPipeline()(p, assets());
    expect(m.v.minFeature).toBe(3);
    expect(m.v.minFragment).toBe(9);
    expect(p.params.minFeature).toBe('3');
    expect(p.params.minFragment).toBe('9');
  });
});

describe('Gabriel image sliver (200×150, 1.5 mm, 20 mm gap, 6 plates)', () => {
  it('keep mode splits a plate into a thin unanchored cap and the parent', () => {
    const m = run('keep');
    expect(m.v.plateCount).toBe(6);
    expect(m.v.thickness).toBe(1.5);
    expect(m.v.plateGap).toBe(20);
    expect(m.v.baseLength).toBe(200);
    expect(m.v.baseWidth).toBe(150);
    const split = m.sliced.plates.filter((pl) => pl.parts.length > 1);
    expect(split.length).toBeGreaterThan(0);
    const slivers = m.sliced.parts.filter((p) => !p.anchored);
    expect(slivers.length).toBeGreaterThan(0);
    const s = slivers[0];
    const span = Math.min(s.bbox.maxX - s.bbox.minX, s.bbox.maxY - s.bbox.minY);
    expect(span).toBeLessThan(3);
    expect(m.issues.some((i) => i.type === 'unanchored' && i.partId === s.id)).toBe(true);
    expect(m.bom.partCount).toBeGreaterThan(m.bom.plateCount);
    assertCountsAgree(m);
  });

  it('auto drops the sliver so plates and parts agree at 6', () => {
    const m = run('auto');
    expect(m.sliced.fragments.some((e) => e.action === 'dropped' || e.action === 'merged')).toBe(true);
    expect(m.sliced.parts.every((p) => p.anchored)).toBe(true);
    expect(m.bom.plateCount).toBe(6);
    expect(m.bom.partCount).toBe(6);
    expect(m.sliced.parts).toHaveLength(6);
    assertCountsAgree(m);
    const html = buildPackHtml(newProject(), m);
    expect(html).toMatch(/6 plates · 6 laser-cut parts/);
    expect(html).toMatch(/Dropped/);
    expect(m.issues.filter((i) => i.type === 'unanchored')).toHaveLength(0);
    const zip = unzipSync(buildZip(m, newProject()));
    const laser = Object.keys(zip).filter((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf'));
    expect(laser).toHaveLength(6);
    const readme = strFromU8(zip['README.txt']);
    expect(readme).toMatch(/dropped|merged/i);
    expect(readme).toMatch(/6 plates and 6 laser-cut parts/);
    expect(Object.keys(zip)).toContain('manifest.json');
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    expect(manifest.plateCount).toBe(6);
    expect(manifest.partCount).toBe(6);
    expect(manifest.parts).toHaveLength(6);
    expect(manifest.nestedParts).toBe(6);
    expect(manifest.fragments.some((e: { action: string }) => e.action === 'dropped' || e.action === 'merged')).toBe(true);
  });
});
