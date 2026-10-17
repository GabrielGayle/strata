import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { rect, pointInShape, shapeBBox, difference, circle } from '../src/core/geom2d';
import {
  applyStackRodSmall,
  heldIslandKeys,
  holeDisks,
  LABEL_HOLE_CLEAR_MM,
  pathsHitDisk,
  placeStackRods,
  punchStackRodHoles,
  resolveStackRodStickOut,
  stackRodsCsv,
  stackRodsUnsupported,
  stackRodSettings,
  type StackRodIsland,
  type StackRodSettings,
} from '../src/core/stackRods';
import { placeLabel } from '../src/core/slicer';
import { engravingHoleIssues } from '../src/core/checks';
import { partDxf, buildZip, FitCheckExportError } from '../src/core/exporters';
import { assertStrictDxfR2000, dxfCutCircles, dxfEntitySummary } from '../src/core/dxf';
import { STACK_ROD_PARAMS, sliverBarGray, twoPeakGray } from './stack-rods-fixture';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapPresetSpec, NEASDEN_MAP_BBOX } from '../src/core/mapPresets';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { mapDepthToGray } from '../src/core/mapPlateHeight';

function settings(over: Partial<StackRodSettings> = {}): StackRodSettings {
  return { diameter: 6, clearance: 0.5, edge: 3, stickOut: 0, thickness: 3, minFeature: 2, baseTop: 60, small: 'keep', ...over };
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

  it('warns when a held sliver is too thin for a hole, and does not error', () => {
    const plan = placeStackRods(
      [island(0, rect(-40, -40, 40, 40), 'base'), island(1, rect(-4, -18, 4, 18), 'sliver')],
      settings(),
    );
    expect(plan.rods.length).toBeGreaterThanOrEqual(1);
    expect(plan.issues.some((i) => i.severity === 'error')).toBe(false);
    const warn = plan.issues.find((i) => i.partId === 'sliver');
    expect(warn?.severity).toBe('warn');
    expect(warn?.held).toBe(true);
    expect(warn?.message).toMatch(/L1/);
    expect(warn?.message).toMatch(/sliver/);
    expect(stackRodsUnsupported(plan).some((i) => i.partId === 'sliver')).toBe(true);
  });

  it('errors when a floating sliver would fall off', () => {
    const plan = placeStackRods(
      [island(0, rect(-50, -20, -10, 20), 'left'), island(1, rect(10, -20, 50, 20), 'right')],
      settings(),
    );
    const err = plan.issues.find((i) => i.partId === 'right');
    expect(err?.severity).toBe('error');
    expect(err?.held).toBe(false);
    expect(err?.message).toMatch(/would fall off/);
    expect(stackRodsUnsupported(plan).some((i) => i.partId === 'right')).toBe(true);
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

  it('treats layer 0 as held even when too small for a hole', () => {
    const plan = placeStackRods([island(0, rect(-4, -18, 4, 18), 'bar')], settings());
    expect(plan.rods).toHaveLength(0);
    expect(plan.issues[0]?.severity).toBe('warn');
    expect(plan.issues[0]?.held).toBe(true);
    expect(plan.issues[0]?.message).toMatch(/sits on the base/);
  });
});

describe('heldIslandKeys', () => {
  it('marks the base layer and anything glued to a held island', () => {
    const islands = [
      island(0, rect(-40, -40, 40, 40), 'base'),
      island(1, rect(-20, -20, 20, 20), 'mid'),
      island(2, rect(80, -10, 100, 10), 'float'),
    ];
    const held = heldIslandKeys(islands);
    expect(held.has('L0:base')).toBe(true);
    expect(held.has('L1:mid')).toBe(true);
    expect(held.has('L2:float')).toBe(false);
  });
});

describe('stick-out vs plates above', () => {
  it('clamps stick-out when the plate above cannot take a hole', () => {
    const base = rect(-40, -40, 40, 40);
    const mid = rect(-25, -25, 25, 25);
    const plan = placeStackRods([island(0, base, 'base'), island(1, mid, 'mid')], settings({ stickOut: 10 }));
    expect(plan.rods).toHaveLength(1);
    expect(plan.rods[0].topLayer).toBe(1);
    const { x, y } = plan.rods[0];
    // 4 mm of material to one side of the rod — inside the plate, too close for the hole.
    const thinAbove = rect(x - 4, y - 20, x + 40, y + 20);
    resolveStackRodStickOut(
      plan,
      [
        { family: 'P', index: 0, shape: base },
        { family: 'P', index: 1, shape: mid },
        { family: 'P', index: 2, shape: thinAbove },
      ],
      settings({ stickOut: 10 }),
      2,
    );
    expect(plan.rods[0].topLayer).toBe(1);
    expect(plan.rods[0].length).toBeCloseTo(6);
  });

  it('cuts a hole through a plate the stick-out reaches when the hole fits', () => {
    const a = rect(-40, -40, 40, 40);
    const b = rect(-25, -25, 25, 25);
    const plan = placeStackRods([island(0, a, 'a'), island(1, b, 'b')], settings({ stickOut: 10 }));
    expect(plan.rods[0].topLayer).toBe(1);
    const airThenSolid = [
      { family: 'P', index: 0, shape: a },
      { family: 'P', index: 1, shape: b },
      { family: 'P', index: 3, shape: rect(-40, -40, 40, 40) },
    ];
    resolveStackRodStickOut(plan, airThenSolid, settings({ stickOut: 10 }), 3);
    expect(plan.rods[0].topLayer).toBe(3);
    expect(plan.rods[0].length).toBeCloseTo(16);
  });

  it('keeps stick-out above the top of the stack', () => {
    const a = rect(-30, -30, 30, 30);
    const plan = placeStackRods([island(0, a, 'a')], settings({ stickOut: 5 }));
    resolveStackRodStickOut(plan, [{ family: 'P', index: 0, shape: a }], settings({ stickOut: 5 }), 0);
    expect(plan.rods[0].length).toBeCloseTo(8);
  });
});

describe('label placement stays clear of holes', () => {
  it('moves the part number off a centre hole', () => {
    const punched = difference(rect(-22, -22, 22, 22), circle(0, 0, 3.25));
    expect(punched[0]?.holes.length).toBe(1);
    const lab = placeLabel('S-04A', punched[0], [0, -14], 6);
    expect(lab).toBeTruthy();
    expect(pathsHitDisk(lab!.paths, [0, 0], 3.25 + LABEL_HOLE_CLEAR_MM)).toBe(false);
    const disks = holeDisks(punched);
    expect(disks.length).toBe(1);
  });

  it('errors when engraving crosses a hole', () => {
    const punched = difference(rect(-22, -22, 22, 22), circle(0, 0, 3.25));
    const hits = engravingHoleIssues({
      id: 'S-04a',
      plateKey: 'L3',
      shape: punched,
      etch: [],
      labelPaths: [
        [
          [-2, 0],
          [2, 0],
        ],
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('error');
    expect(hits[0].type).toBe('label');
    expect(hits[0].message).toMatch(/S-04a/);
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
    expect(m.sliced.stackRods!.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.sliced.stackRods!.rods.length).toBe(2);
    expect(m.sliced.stackRods!.hole).toBeCloseTo(6.5, 5);

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

    for (const q of m.sliced.parts.filter((x) => x.family === 'P')) {
      for (const d of holeDisks(q.shape)) {
        expect(pathsHitDisk([...q.labelPaths, ...q.etch], d.c, d.r), `${q.id} engraving vs hole`).toBe(false);
      }
    }
    expect(m.issues.filter((i) => i.type === 'label' && i.severity === 'error')).toEqual([]);

    const zip = unzipSync(buildZip(m, p));
    expect(Object.keys(zip)).toContain('rods.csv');
    const csv = strFromU8(zip['rods.csv']);
    expect(csv).toMatch(/^rod_id,diameter_mm,length_mm\n/);
    expect(csv).toContain('R1,');
    expect(csv).toContain('R2,');
    expect(csv).not.toContain('R3,');
    expect(strFromU8(zip['cutlist.csv'])).toContain('rod_id,diameter_mm,length_mm');
    const html = strFromU8(zip['build-pack.html']);
    expect(html).toContain(`data-rod-count="${m.sliced.stackRods!.rods.length}"`);
    expect(html).toContain('Support rods');
    expect(m.bom.supportRods?.length).toBe(2);
    expect(stackRodsCsv(m.sliced.stackRods!)).toBe(csv);
  });

  it('does not block export when a held sliver cannot take a rod', () => {
    const p = newProject();
    const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
    p.params = {
      ...p.params,
      ...preset.params,
      ...STACK_ROD_PARAMS,
      fragmentMode: 'keep',
      minPartSize: '0',
      minFragment: '0',
      plateCount: '4',
    };
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: sliverBarGray(), insMesh: null, srcMesh: null });
    expect(m.issues.filter((i) => i.severity === 'error' && i.type === 'rod')).toEqual([]);
    const rodWarn = m.issues.filter((i) => i.type === 'rod' && i.severity === 'warn');
    expect(rodWarn.length).toBeGreaterThan(0);
    expect(rodWarn[0].message).toMatch(/Layer L0 island /);
    expect(() => buildZip(m, p)).not.toThrow();
  });

  it('refuses export when a floating island cannot take a rod', () => {
    const plan = placeStackRods(
      [island(0, rect(-50, -20, -10, 20), 'left'), island(1, rect(-4, 30, 4, 48), 'sliver')],
      settings(),
    );
    expect(plan.issues.some((i) => i.severity === 'error' && i.partId === 'sliver')).toBe(true);
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

describe('applyStackRodSmall', () => {
  it('drops an uncovered held island in drop mode', () => {
    const sliver = {
      id: 'sliver',
      plateKey: 'L1',
      family: 'P',
      index: 1,
      shape: rect(-4, -18, 4, 18),
      area: 144,
      perimeter: 80,
      bbox: shapeBBox(rect(-4, -18, 4, 18)),
      etch: [],
    };
    const base = {
      id: 'base',
      plateKey: 'L0',
      family: 'P',
      index: 0,
      shape: rect(-40, -40, 40, 40),
      area: 6400,
      perimeter: 320,
      bbox: shapeBBox(rect(-40, -40, 40, 40)),
      etch: [],
    };
    const plan = placeStackRods(
      [island(0, base.shape, 'base'), island(1, sliver.shape, 'sliver')],
      settings({ small: 'drop' }),
    );
    expect(plan.issues.some((i) => i.partId === 'sliver' && i.severity !== 'error')).toBe(true);
    const plates = [
      { def: { key: 'L0' }, parts: [base] },
      { def: { key: 'L1' }, parts: [sliver] },
    ];
    applyStackRodSmall([base, sliver], plates, plan, 'drop', 0.15);
    expect(plates[1].parts).toHaveLength(0);
    expect(plan.issues.every((i) => i.severity !== 'error')).toBe(true);
  });
});

describe('stackRodSettings', () => {
  it('reads defaults from values', () => {
    const s = stackRodSettings(
      { stackRodDia: 6, stackRodClearance: 0.5, stackRodEdge: 3, stackRodStickOut: 0, thickness: 3, minFeature: 2 } as any,
      12,
    );
    expect(s.diameter).toBe(6);
    expect(s.clearance).toBe(0.5);
    expect(s.edge).toBe(3);
    expect(s.stickOut).toBe(0);
    expect(s.small).toBe('keep');
    expect(s.baseTop).toBe(12);
  });
});

function liveLikeNeasdenGrid(): Float32Grid {
  const b = metricBounds(NEASDEN_MAP_BBOX, 'EPSG:27700');
  const w = 64;
  const h = 64;
  const pixelW = (b.east - b.west) / w;
  const pixelH = (b.north - b.south) / h;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      let z = 35 + 4 * Math.sin(u * 8) * Math.cos(v * 6);
      const hill = Math.exp(-((u - 0.75) ** 2 + (v - 0.8) ** 2) / 0.04);
      const dip = Math.exp(-((u - 0.2) ** 2 + (v - 0.2) ** 2) / 0.05);
      z = z + hill * (86 - z) + dip * (18.8 - z);
      data[y * w + x] = z;
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: {
      originX: b.west + pixelW / 2,
      originY: b.south + pixelH / 2,
      pixelW,
      pixelH,
    },
  };
}

describe('support poles on a stamped DEM', { timeout: 90_000 }, () => {
  it('exports with poles on and 0 errors', async () => {
    const plateCount = 20;
    const grid = liveLikeNeasdenGrid();
    const bundle = await buildMapBundle(
      defaultMapSpec({
        ...mapPresetSpec('neasden'),
        bbox: NEASDEN_MAP_BBOX,
        source: 'ea-dtm',
        water: 'raw',
        exaggeration: 11,
        layerBudget: 'jenks',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => grid,
        allowOverpassNetwork: false,
        stack: { plateCount, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' },
      },
    );
    const p = newProject();
    const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
    p.params = { ...p.params, ...preset.params, plateCount: String(plateCount), erosionAmp: '0', crest: '0', slope: '0', insShape: 'none', stackRodsOn: true, flatPins: '0' };
    p.images.top = bundle.asset;
    const gray = mapDepthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    expect(m.v.sliceMode).toBe('flat');
    expect(m.v.stackRodsOn).toBe(true);
    expect(m.sliced.stackRods).toBeTruthy();
    const errors = m.issues.filter((i) => i.severity === 'error');
    expect(errors, errors.map((e) => `${e.partId}: ${e.message}`).join(' | ')).toHaveLength(0);
    expect(m.issues.filter((i) => i.type === 'label' && i.severity === 'error')).toHaveLength(0);
    expect(() => buildZip(m, p)).not.toThrow(FitCheckExportError);
    const zip = unzipSync(buildZip(m, p));
    expect(Object.keys(zip)).toContain('rods.csv');
  });
});
