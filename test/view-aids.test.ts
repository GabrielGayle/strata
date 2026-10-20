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

describe('raking light', () => {
  it('points at the turn and height asked for', async () => {
    const { rakeDirection } = await import('../src/ui/viewAids');
    const [x, y, z] = rakeDirection(0, 15);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 6);
    expect(z).toBeGreaterThan(0.9);
    const side = rakeDirection(90, 10);
    expect(side[0]).toBeGreaterThan(0.95);
    expect(Math.hypot(...side)).toBeCloseTo(1, 6);
  });

  it('loads off by default and keeps a saved setting', async () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    const { loadViewAids, saveViewAids, DEFAULT_VIEW_AIDS } = await import('../src/ui/viewAids');
    expect(loadViewAids().rake).toBe(false);
    saveViewAids({ ...DEFAULT_VIEW_AIDS, rake: true, rakeTurn: 405, rakeHeight: 10 });
    store.set('strata.viewAids.v1', store.get('strata.viewAids.v1')!);
    const a = loadViewAids();
    expect(a.rake).toBe(true);
    expect(a.rakeTurn).toBe(45);
    expect(a.rakeHeight).toBe(10);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
