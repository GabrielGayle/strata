import { describe, expect, it } from 'vitest';
import { depthToGray } from '../src/core/depth';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { pointInShape } from '../src/core/geom2d';
import { baseTop } from '../src/core/slicer';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';

describe('mapToDepth', () => {
  it('depthToGray is monotonic from cone centre to rim', () => {
    const grid = syntheticConeGrid(48, 24, 18);
    const { depth } = mapGridToDepth(grid);
    const gray = depthToGray(depth);
    const cx = Math.floor(gray.w / 2);
    const cy = Math.floor(gray.h / 2);
    const centre = gray.data[cy * gray.w + cx];
    const rim = gray.data[cy * gray.w + (cx + Math.floor(gray.w * 0.35))];
    expect(centre).toBeLessThan(rim);
    expect(centre).toBeLessThan(0.35);
    expect(rim).toBeGreaterThan(0.6);
  });

  it('synthetic cone yields stacked plates with widening hole toward the top', () => {
    const grid = syntheticConeGrid(96, 35, 28);
    const { depth } = mapGridToDepth(grid, { exaggeration: 2.5 });
    const gray = depthToGray(depth);
    const p = newProject();
    const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
    p.params = {
      ...p.params,
      ...preset.params,
      plateCount: '12',
      topDepth: '30',
      imgSmooth: '0',
      imgContrast: '1',
      topThreshold: '0.05',
    };
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    const layers = m.sliced.plates;
    expect(layers.length).toBe(12);
    const centre: [number, number] = [0, 0];
    const solidAtCentre = layers.map((pl) => pl.parts.some((q) => pointInShape(centre, q.shape)));
    expect(solidAtCentre[0]).toBe(true);
    expect(solidAtCentre[solidAtCentre.length - 1]).toBe(false);
    const firstHole = solidAtCentre.findIndex((s) => !s);
    expect(firstHole).toBeGreaterThan(0);
    expect(firstHole).toBeLessThan(solidAtCentre.length);
    const t = m.v.thickness;
    const area = layers.map((pl) => pl.parts.reduce((a, q) => a + q.area, 0));
    for (let i = 1; i < area.length; i++) expect(area[i]).toBeLessThanOrEqual(area[i - 1] + 1);
    expect(layers[0].def.plane.origin[1]).toBeCloseTo(baseTop(m.v) + 0.5 * t, 3);
  });
});
