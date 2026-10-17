import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { rect, pointInShape, shapeBBox } from '../src/core/geom2d';
import {
  placeStackRods,
  punchStackRodHoles,
  stackRodsCsv,
  stackRodSettings,
  type StackRodIsland,
  type StackRodSettings,
} from '../src/core/stackRods';
import { partDxf, buildZip, FitCheckExportError } from '../src/core/exporters';
import { assertStrictDxfR2000, dxfCutCircles, dxfEntitySummary } from '../src/core/dxf';
import { STACK_ROD_PARAMS, twoPeakGray } from './stack-rods-fixture';

function settings(over: Partial<StackRodSettings> = {}): StackRodSettings {
  return { diameter: 6, clearance: 0.5, edge: 3, stickOut: 0, thickness: 3, minFeature: 2, baseTop: 60, ...over };
}

function island(layer: number, shape: ReturnType<typeof rect>, partId = `p${layer}`): StackRodIsland {
  return { key: `L${layer}:${partId}`, layer, plateKey: `L${layer}`, partId, shape };
}

describe('placeStackRods (synthetic stacks)', () => {
  it('gives a single peak one rod', () => {
    const plan = placeStackRods([island(0, rect(-20, -20, 20, 20), 'peak')], settings());
    expect(plan.issues).toEqual([]);
    expect(plan.rods).toHaveLength(1);
    expect(plan.hole).toBeCloseTo(6.5);
    expect(plan.rods[0].id).toBe('R1');
    expect(plan.rods[0].length).toBeCloseTo(3);
    expect(pointInShape([plan.rods[0].x, plan.rods[0].y], rect(-20, -20, 20, 20))).toBe(true);
  });

  it('gives two separated peaks two rods', () => {
    const plan = placeStackRods(
      [island(0, rect(-70, -20, -30, 20), 'left'), island(0, rect(30, -20, 70, 20), 'right')],
      settings(),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.rods).toHaveLength(2);
    const xs = plan.rods.map((r) => r.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(-20);
    expect(xs[1]).toBeGreaterThan(20);
  });

  it('reuses one rod through a stacked tower', () => {
    const plan = placeStackRods(
      [
        island(0, rect(-40, -40, 40, 40), 'base'),
        island(1, rect(-25, -25, 25, 25), 'mid'),
        island(2, rect(-18, -18, 18, 18), 'top'),
      ],
      settings({ stickOut: 5 }),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.rods).toHaveLength(1);
    expect(plan.rods[0].topLayer).toBe(2);
    expect(plan.rods[0].length).toBeCloseTo(3 * 3 + 5);
    expect(plan.rods[0].islands.length).toBe(3);
  });

  it('errors when a sliver is too thin for a hole at the min edge distance', () => {
    const plan = placeStackRods(
      [island(0, rect(-40, -40, 40, 40), 'base'), island(1, rect(-4, -18, 4, 18), 'sliver')],
      settings(),
    );
    expect(plan.rods.length).toBeGreaterThanOrEqual(1);
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.issues[0].severity).toBe('error');
    expect(plan.issues[0].message).toMatch(/L1/);
    expect(plan.issues[0].message).toMatch(/sliver/);
    expect(plan.issues[0].plateKey).toBe('L1');
    expect(plan.issues[0].partId).toBe('sliver');
  });

  it('is deterministic', () => {
    const islands = [
      island(0, rect(-40, -40, 40, 40), 'base'),
      island(1, rect(-70, -20, -30, 20), 'left'),
      island(1, rect(30, -20, 70, 20), 'right'),
    ];
    const a = placeStackRods(islands, settings());
    const b = placeStackRods(islands, settings());
    expect(a.rods.map((r) => [r.id, r.x, r.y, r.length])).toEqual(b.rods.map((r) => [r.id, r.x, r.y, r.length]));
  });

  it('errors when an island has no solid column down to the base', () => {
    const plan = placeStackRods(
      [island(0, rect(-50, -20, -10, 20), 'left'), island(1, rect(10, -20, 50, 20), 'right')],
      settings(),
    );
    expect(plan.issues.some((i) => i.partId === 'right')).toBe(true);
  });
});

function runFlat(extra: Record<string, string | boolean> = {}) {
  const p = newProject();
  const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
  p.params = { ...p.params, ...preset.params, ...STACK_ROD_PARAMS, ...extra };
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: twoPeakGray(), insMesh: null, srcMesh: null });
  return { p, m };
}

describe('support poles on a stamped two-peak stack', { timeout: 60_000 }, () => {
  it('places two rods, punches CIRCLE holes, and writes rods.csv', () => {
    const { p, m } = runFlat();
    expect(m.v.sliceMode).toBe('flat');
    expect(m.sliced.stackRods).toBeTruthy();
    expect(m.sliced.stackRods!.issues).toEqual([]);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.sliced.stackRods!.rods.length).toBe(2);
    expect(m.sliced.stackRods!.hole).toBeCloseTo(6.5, 5);

    const rod = m.sliced.stackRods!.rods[0];
    const part = m.sliced.parts.find((q) => q.family === 'P' && q.index === 0);
    expect(part).toBeTruthy();
    const dxf = partDxf(part!, m.v);
    assertStrictDxfR2000(dxf);
    const sum = dxfEntitySummary(dxf);
    expect(sum.types.CIRCLE).toBeGreaterThan(0);
    expect(sum.types.SPLINE).toBeUndefined();
    const circles = dxfCutCircles(dxf);
    const kerfR = m.sliced.stackRods!.hole / 2 - m.v.kerf / 2;
    expect(circles.some((c) => Math.abs(c.r - kerfR) < 0.35)).toBe(true);

    for (const r of m.sliced.stackRods!.rods) {
      for (let layer = 0; layer <= r.topLayer; layer++) {
        const owners = m.sliced.parts.filter((q) => q.family === 'P' && q.index === layer && q.shape.some((ex) => ex.holes.length));
        const hit = owners.filter((q) =>
          q.shape.some((ex) =>
            ex.holes.some((h) => {
              const bb = shapeBBox([{ outer: h, holes: [] }]);
              return Math.hypot((bb.minX + bb.maxX) / 2 - r.x, (bb.minY + bb.maxY) / 2 - r.y) < 2;
            }),
          ),
        );
        expect(hit.length, `rod ${r.id} layer ${layer}`).toBe(1);
      }
    }

    const zip = unzipSync(buildZip(m, p));
    expect(Object.keys(zip)).toContain('rods.csv');
    const csv = strFromU8(zip['rods.csv']);
    expect(csv).toMatch(/^rod_id,diameter_mm,length_mm\n/);
    expect(csv).toContain('R1,');
    expect(csv).toContain('R2,');
    expect(strFromU8(zip['cutlist.csv'])).toContain('rod_id,diameter_mm,length_mm');
    const html = strFromU8(zip['build-pack.html']);
    expect(html).toContain(`data-rod-count="${m.sliced.stackRods!.rods.length}"`);
    expect(html).toContain('Support rods');
    expect(m.bom.supportRods?.length).toBe(2);
    expect(stackRodsCsv(m.sliced.stackRods!)).toBe(csv);
  });

  it('refuses export when an island cannot take a rod', () => {
    const { p, m } = runFlat({ stackRodEdge: '40' });
    expect(m.issues.some((i) => i.severity === 'error' && i.type === 'rod')).toBe(true);
    expect(m.issues.find((i) => i.type === 'rod')!.message).toMatch(/Layer L/);
    expect(() => buildZip(m, p)).toThrow(FitCheckExportError);
  });

  it('stays off unless Support poles is on', () => {
    const { m } = runFlat({ stackRodsOn: false });
    expect(m.sliced.stackRods).toBeNull();
    expect(m.issues.filter((i) => i.type === 'rod')).toEqual([]);
  });
});

describe('punchStackRodHoles', () => {
  it('cuts a hole at the rod, leaving the rest of the part', () => {
    const shape = rect(-30, -30, 30, 30);
    const part = { family: 'P', index: 0, shape, area: 3600, perimeter: 240, bbox: shapeBBox(shape) };
    const plan = placeStackRods([island(0, shape, 'a')], settings());
    punchStackRodHoles([part], plan);
    expect(part.shape[0].holes.length).toBe(1);
    expect(pointInShape([plan.rods[0].x, plan.rods[0].y], part.shape)).toBe(false);
  });
});

describe('stackRodSettings', () => {
  it('reads defaults from values', () => {
    const s = stackRodSettings({ stackRodDia: 6, stackRodClearance: 0.5, stackRodEdge: 3, stackRodStickOut: 0, thickness: 3, minFeature: 2 } as any, 12);
    expect(s.diameter).toBe(6);
    expect(s.clearance).toBe(0.5);
    expect(s.edge).toBe(3);
    expect(s.stickOut).toBe(0);
    expect(s.baseTop).toBe(12);
  });
});
