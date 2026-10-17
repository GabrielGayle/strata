import { describe, expect, it } from 'vitest';
import {
  buildMapSunkenFrameLayout,
  buildMapSunkenFrameMould,
  DEFAULT_FRAME_CAST_TOLERANCE_MM,
  SUNKEN_FRAME_FLAT_ONLY_HINT,
  sunkenFrameApplies,
} from '../src/core/mapSunkenFrame';
import { extrudeSunkenFrame } from '../src/core/geometry3d';
import { rect, shapeArea, shapeBBox, type BBox, type Shape } from '../src/core/geom2d';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { projectWithTopMapSpec } from '../src/core/mapTopAsset';
import { defaultMapSpec } from '../src/core/mapSpec';
import type { SliceResult } from '../src/core/slicer';

function mockSliced(shapes: Shape[], keys?: string[]): SliceResult {
  return {
    plates: [],
    parts: shapes.map((shape, i) => ({
      id: keys?.[i] ?? `P${i}`,
      plateKey: keys?.[i] ?? `P${i}`,
      family: 'P',
      index: i,
      piece: 0,
      plane: { origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
      thickness: 3,
      shape,
      etch: [],
      labelPaths: [],
      labelAt: null,
      area: 1000,
      perimeter: 200,
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 } as BBox,
      anchored: false,
      kind: 'plate',
    })),
    warnings: [],
    fragments: [],
    front: null,
    top: null,
    support: null,
    tuning: null,
    brace: null,
    stackRods: null,
  };
}

describe('map sunken concrete frame (T28)', () => {
  it('gives every plate a seat depth and an outer mould outline', () => {
    const sliced = mockSliced([rect(0, 0, 80, 80), rect(10, 10, 70, 70)]);
    const mould = buildMapSunkenFrameMould(sliced, { sunkenFrame: { enabled: true } }, 3);
    expect(mould.parts.length).toBe(1);
    expect(mould.notes.some((n) => /P0 seat/.test(n))).toBe(true);
    expect(mould.notes.some((n) => /P1 seat/.test(n))).toBe(true);
    expect(mould.notes.some((n) => /kg/.test(n))).toBe(true);
    expect(DEFAULT_FRAME_CAST_TOLERANCE_MM).toBeGreaterThan(0);
  });

  it('builds a mould from flat-stack L-keys (family P)', () => {
    const sliced = mockSliced([rect(0, 0, 80, 80), rect(10, 10, 70, 70)], ['L0', 'L1']);
    const mould = buildMapSunkenFrameMould(sliced, { sunkenFrame: { enabled: true, wallMm: 12 } }, 3);
    expect(mould.parts.length).toBe(1);
    expect(mould.notes.some((n) => /L0 seat/.test(n))).toBe(true);
    expect(mould.notes.some((n) => /L1 seat/.test(n))).toBe(true);
  });

  it('returns no 3D layout when the frame is off', () => {
    const sliced = mockSliced([rect(0, 0, 80, 80)]);
    expect(buildMapSunkenFrameLayout(sliced, { sunkenFrame: { enabled: false } }, 3, 60)).toBeNull();
    expect(buildMapSunkenFrameLayout(sliced, {}, 3, 60)).toBeNull();
  });

  it('builds a pit with a ring, floor, lip, and plate drop', () => {
    const sliced = mockSliced([rect(-40, -30, 40, 30)], ['L0']);
    const layout = buildMapSunkenFrameLayout(sliced, { sunkenFrame: { enabled: true, wallMm: 12 } }, 3, 60);
    expect(layout).not.toBeNull();
    expect(layout!.layerCount).toBe(1);
    expect(layout!.wallMm).toBe(12);
    expect(layout!.floorMm).toBe(12);
    expect(layout!.rimY).toBe(12 + 3 + 12);
    expect(layout!.plateLiftMm).toBe(12 - 60);
    expect(layout!.ring.length).toBeGreaterThan(0);
    expect(shapeArea(layout!.ring)).toBeGreaterThan(100);
    expect(shapeArea(layout!.outer)).toBeGreaterThan(shapeArea(layout!.cavity));
    const outer = shapeBBox(layout!.outer);
    const cavity = shapeBBox(layout!.cavity);
    expect(outer.minX).toBeLessThan(cavity.minX);
    expect(outer.maxX).toBeGreaterThan(cavity.maxX);
    const geo = extrudeSunkenFrame(layout!);
    expect(geo.getAttribute('position').count).toBeGreaterThan(24);
    geo.dispose();
  });

  it('unions an extra outer so a sized base still forms the wall', () => {
    const sliced = mockSliced([rect(-20, -15, 20, 15)], ['L0']);
    const extra = rect(-100, -80, 100, 80);
    const layout = buildMapSunkenFrameLayout(sliced, { sunkenFrame: { enabled: true, wallMm: 12 } }, 3, 60, extra);
    const bb = shapeBBox(layout!.outer);
    expect(bb.minX).toBeLessThanOrEqual(-99);
    expect(bb.maxX).toBeGreaterThanOrEqual(99);
    expect(shapeArea(layout!.ring)).toBeGreaterThan(shapeArea(layout!.cavity));
  });

  it('wires the pit into the pipeline for a stamped stack with the checkbox on', () => {
    const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
    let p = newProject();
    p.params = { ...p.params, ...preset.params, plateCount: '4' };
    p = projectWithTopMapSpec(
      p,
      defaultMapSpec({
        bbox: [-0.26, 51.545, -0.23, 51.565],
        sunkenFrame: { enabled: true, wallMm: 12 },
        title: 'Neasden',
      }),
    );
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
    expect(m.v.sliceMode).toBe('flat');
    expect(m.sunkenFrame).not.toBeNull();
    expect(m.sunkenFrame!.ring.length).toBeGreaterThan(0);
    expect(m.sunkenFrame!.rimY).toBeGreaterThan(m.sunkenFrame!.floorMm);
    expect(m.sunkenFrame!.plateLiftMm).toBeLessThan(0);
  });

  it('does not build a pit on Vermilion (upright slats) even when the map flag is on', () => {
    const preset = PRESETS.find((x) => x.name === 'Vermilion 40')!;
    let p = newProject();
    p.params = { ...p.params, ...preset.params, plateCount: '6' };
    p = projectWithTopMapSpec(
      p,
      defaultMapSpec({
        bbox: [-0.26, 51.545, -0.23, 51.565],
        sunkenFrame: { enabled: true, wallMm: 12 },
        title: 'Neasden',
      }),
    );
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
    expect(m.v.sliceMode).toBe('parallel');
    expect(sunkenFrameApplies(m.v.sliceMode)).toBe(false);
    expect(sunkenFrameApplies('flat')).toBe(true);
    expect(m.sunkenFrame).toBeNull();
    expect(SUNKEN_FRAME_FLAT_ONLY_HINT).toMatch(/Stamped stack/);
    expect(SUNKEN_FRAME_FLAT_ONLY_HINT).toMatch(/Vermilion/);
  });
});
