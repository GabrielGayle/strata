import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { pointInShape } from '../src/core/geom2d';
import { baseTop } from '../src/core/slicer';
import { partDxf } from '../src/core/exporters';
import type { Gray } from '../src/core/image';

// white image with a dark cone: black at the centre, fading out to white at the rim
function cone(w = 120, h = 80): Gray {
  const data = new Float32Array(w * h).fill(1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2) / (h * 0.4);
      if (d < 1) data[y * w + x] = d;
    }
  return { w, h, data };
}

function run(extra: Record<string, string> = {}, img: Gray | null = cone()) {
  const p = newProject();
  const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
  p.params = { ...p.params, ...preset.params, imgSmooth: '0', imgContrast: '1', topThreshold: '0.05', ...extra };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: img, insMesh: null, srcMesh: null });
}

describe('flat stack (face to face) with an image stamp', () => {
  const m = run();
  const layers = m.sliced.plates;
  const t = m.v.thickness;

  it('lays the plates flat, one thickness apart, on top of the base', () => {
    expect(layers.length).toBe(20);
    layers.forEach((pl, i) => {
      expect(pl.def.key).toBe(`L${i}`);
      expect(pl.def.plane.normal).toEqual([0, 1, 0]);
      expect(pl.def.plane.origin[1]).toBeCloseTo(baseTop(m.v) + (i + 0.5) * t, 6);
      expect(pl.parts.length).toBeGreaterThan(0);
    });
  });

  it('presses the dark centre down through more layers than the paler rim', () => {
    const centre: [number, number] = [0, 0];
    const solidAtCentre = layers.map((pl) => pl.parts.some((q) => pointInShape(centre, q.shape)));
    const depth = m.v.topDepth;
    const top = layers.length * t;
    solidAtCentre.forEach((solid, i) => {
      const mid = (i + 0.5) * t;
      // the cone's tip reaches the full impression depth below the top
      if (mid > top - depth + t) expect(solid).toBe(false);
      if (mid < top - depth - t) expect(solid).toBe(true);
    });
    expect(solidAtCentre[0]).toBe(true); // the bottom layer is never cut through
    // holes widen towards the top: each layer keeps no more material than the one below
    const area = layers.map((pl) => pl.parts.reduce((a, q) => a + q.area, 0));
    for (let i = 1; i < area.length; i++) expect(area[i]).toBeLessThanOrEqual(area[i - 1] + 1);
    expect(area[area.length - 1]).toBeLessThan(area[0] - 1000);
  });

  it('runs registration pins straight through the layers and etches glue-up guides', () => {
    const bottom = layers[0].parts[0].shape[0];
    expect(bottom.holes.length).toBe(2); // two pins, no stamp hole
    const centres = bottom.holes.map((h) => {
      const xs = h.map((q) => q[0]), ys = h.map((q) => q[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] as [number, number];
    });
    for (const pl of layers) for (const c of centres) expect(pl.parts.some((q) => pointInShape(c, q.shape))).toBe(false);
    // a layer just under the impression carries the outline of the hole above it
    const firstCut = layers.findIndex((pl) => pl.parts[0].shape[0].holes.length > 2);
    expect(firstCut).toBeGreaterThan(0);
    expect(layers[firstCut - 1].parts[0].etch.length).toBeGreaterThan(0);
  });

  it('is laser-ready: no fit errors, every piece supported, DXF out', () => {
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.sliced.parts.every((q) => q.anchored)).toBe(true);
    expect(m.nested.unplaced).toEqual([]);
    expect(partDxf(m.sliced.parts[m.sliced.parts.length - 1], m.v)).toContain('LWPOLYLINE');
    expect(m.moulds.parts.some((p) => p.kind === 'jig')).toBe(false);
  });

  it('raise mode leaves the dark shape standing on solid layers', () => {
    // raise mode with a deep stamp: the pale background sinks, so the dark cone stands up on its own
    const r = run({ imgTopMode: 'raise', topDepth: '40', topThreshold: '0' });
    expect(r.sliced.parts.every((q) => q.anchored)).toBe(true); // the cone sits on solid layers below
    expect(r.issues.filter((i) => i.type === 'gap' || i.type === 'collision')).toEqual([]);
  });

  it('works without an image as a plain laminated strata block', () => {
    const r = run({ erosionAmp: '20' }, null);
    expect(r.sliced.plates.length).toBeGreaterThan(10);
    const area = r.sliced.plates.map((pl) => pl.parts.reduce((a, q) => a + q.area, 0));
    expect(area[area.length - 1]).toBeLessThan(area[0]); // the eroded top steps in like a contour model
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
