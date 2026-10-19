import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { contourStep, outlineSegments, reliefRange, spreadOffsets, tintColor } from '../src/ui/viewAids';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const model = createPipeline()(newProject(), assets);
const parts = model.sliced.parts;
const along = (p: (typeof parts)[number], o?: [number, number, number]) =>
  [0, 1, 2].reduce((a, i) => a + (p.plane.origin[i] + (o?.[i] ?? 0)) * p.plane.normal[i], 0);

describe('view aids', () => {
  it('spread opens a parallel stack evenly and leaves the cut parts alone', () => {
    expect(parts.length).toBeGreaterThan(10);
    expect(spreadOffsets(parts, 1).size).toBe(0);
    const before = JSON.stringify(parts.map((p) => p.shape));
    const off = spreadOffsets(parts, 2);
    const ps = [...parts].filter((p) => p.family === parts[0].family).sort((a, b) => along(a) - along(b));
    const gap0 = along(ps[1]) - along(ps[0]);
    const gap1 = along(ps[1], off.get(ps[1].id)) - along(ps[0], off.get(ps[0].id));
    expect(gap1).toBeCloseTo(gap0 * 2, 6);
    expect(JSON.stringify(parts.map((p) => p.shape))).toBe(before);
  });

  it('alternate tint gives neighbouring plates clearly different shades', () => {
    const a = tintColor('alternate', '#5f666b', 0, 40)!;
    const b = tintColor('alternate', '#5f666b', 1, 40)!;
    expect(a).not.toBe(b);
    expect(tintColor('alternate', '#5f666b', 2, 40)).toBe(a);
    const lum = (h: string) => parseInt(h.slice(1, 3), 16);
    expect(lum(b) - lum(a)).toBeGreaterThan(60);
    expect(tintColor('off', '#5f666b', 0, 40)).toBeNull();
    expect(tintColor('rainbow', '#5f666b', 0, 40)).not.toBe(tintColor('rainbow', '#5f666b', 39, 40));
  });

  it('outlines trace every ring on both faces', () => {
    const p = parts[0];
    const pos: number[] = [];
    outlineSegments(p.shape, p.thickness, p.plane, pos);
    const edges = p.shape.reduce((n, ex) => n + ex.outer.length + ex.holes.reduce((m, h) => m + h.length, 0), 0);
    expect(pos.length).toBe(edges * 2 * 2 * 3);
  });

  it('height bands span the plate tops with a sensible contour step', () => {
    const { lo, hi } = reliefRange(parts);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThan(0);
    expect(contourStep(32)).toBe(2);
    expect(contourStep(180)).toBe(10);
  });
});
