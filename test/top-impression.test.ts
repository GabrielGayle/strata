import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { topAt } from '../src/core/slicer';
import type { Gray } from '../src/core/image';
import { partDxf } from '../src/core/exporters';

// white image with a black disc in the middle
function disc(w = 120, h = 60): Gray {
  const data = new Float32Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - w / 2, y - h / 2) < h * 0.3) data[y * w + x] = 0;
  return { w, h, data };
}

describe('top-surface impression', () => {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgTopMode: 'carve', topDepth: '20', topSteps: '1', imgSmooth: '0', imgContrast: '1' };
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: disc(), insMesh: null, srcMesh: null });
  const plates = m.sliced.plates;
  const mid = plates[Math.floor(plates.length / 2)].parts[0];
  const end = plates[0].parts[0];

  it('sinks the plate tops under the dark part of the image', () => {
    expect(m.sliced.top).toBeTruthy();
    const h = m.v.stackHeight;
    expect(topAt(mid.shape, 0)).toBeCloseTo(h - 20, 1); // centre of the disc
    expect(topAt(mid.shape, mid.bbox.maxX - 2)).toBeCloseTo(h, 1); // outside it
    expect(topAt(end.shape, 0)).toBeCloseTo(h, 1); // end plate misses the disc
  });

  it('cuts crisp vertical risers and stays laser-safe', () => {
    const top = mid.shape[0].outer.filter((q) => q[1] > m.v.stackHeight - 25);
    const risers = top.filter((q, i) => {
      const n = top[(i + 1) % top.length];
      return Math.abs(q[0] - n[0]) < 1e-6 && Math.abs(q[1] - n[1]) > 15;
    });
    expect(risers.length).toBeGreaterThanOrEqual(2);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(partDxf(mid, m.v)).toContain('LWPOLYLINE');
  });

  it('smooths only the cut edges, never the outer plate edges', () => {
    const base = { ...p.params, erosionAmp: '12' };
    const run = (extra: Record<string, string>) => {
      const pp = newProject();
      pp.params = { ...base, ...extra };
      return createPipeline()(pp, { sideImg: null, frontImg: null, topImg: disc(), insMesh: null, srcMesh: null });
    };
    const sharp = run({});
    const soft = run({ cutSmooth: '3' });
    const i = Math.floor(soft.sliced.plates.length / 2);
    const a = sharp.sliced.plates[i].parts[0];
    const b = soft.sliced.plates[i].parts[0];
    // outer top edge, well away from the disc, is identical
    for (const u of [b.bbox.minX + 3, b.bbox.minX + 15, b.bbox.maxX - 15, b.bbox.maxX - 3]) expect(Math.abs(topAt(b.shape, u)! - topAt(a.shape, u)!)).toBeLessThan(0.02); // only point simplification, no reshaping
    // the recess floor is filleted: its lowest point is only reached away from the walls
    const floor = Math.min(...b.shape[0].outer.filter((q) => Math.abs(q[0]) < 40).map((q) => q[1]));
    expect(floor).toBeLessThan(sharp.v.stackHeight - 10);
    expect(soft.issues.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('edges, master size and fit to image', () => {
  const run = (params: Record<string, string>, topImg: Gray | null = null) => {
    const pp = newProject();
    pp.params = { ...pp.params, insShape: 'none', ...params };
    return createPipeline()(pp, { sideImg: null, frontImg: null, topImg, insMesh: null, srcMesh: null });
  };
  const roughness = (part: { shape: { outer: [number, number][] }[] }, top: number) => {
    const pts = part.shape[0].outer.filter((q) => q[1] > top).sort((x, y) => x[0] - y[0]);
    let r = 0;
    for (let k = 1; k < pts.length - 1; k++) r += Math.abs(pts[k + 1][1] - 2 * pts[k][1] + pts[k - 1][1]);
    return r;
  };

  it('strata flow smooths the eroded top line', () => {
    const raw = run({});
    const flow = run({ edgeFlow: '40' });
    const a = raw.sliced.parts[10], b = flow.sliced.parts[10];
    expect(roughness(b, 100)).toBeLessThan(roughness(a, 100) * 0.5);
  });

  it('round all corners softens every corner but leaves functional cuts crisp', () => {
    const m = run({ edgeRound: '4', insShape: 'fin' });
    const part = m.sliced.parts[0];
    const e = m.v.embedDepth;
    // the embedded tab's bottom corner is no longer a sharp vertex
    expect(part.shape[0].outer.some((q) => Math.abs(q[1] + e) < 1e-3 && Math.abs(q[0] - part.bbox.minX) < 1e-3)).toBe(false);
    // anchor holes are still full circles (cut after rounding)
    expect(part.shape[0].holes.length).toBeGreaterThanOrEqual(2);
    expect(m.issues.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('master size scales the piece, plate count and thickness but not tolerances', () => {
    const m = run({ masterScale: '0.5' });
    expect(m.v.baseLength).toBeCloseTo(400, 6);
    expect(m.v.baseHeight).toBeCloseTo(60, 6);
    expect(m.v.thickness).toBeCloseTo(1.5, 6);
    expect(m.v.plateCount).toBe(20);
    expect(m.sliced.plates.length).toBe(20);
    expect(m.v.kerf).toBeCloseTo(0.15, 6);
    expect(m.v.clearance).toBeCloseTo(0.5, 6);
    expect(m.v.sheetW).toBe(2500);
    const keepCount = run({ masterScale: '0.5', masterCount: 'false', masterThickness: 'false' });
    expect(keepCount.v.plateCount).toBe(40);
    expect(keepCount.v.thickness).toBe(3);
  });

  it('fit stack to image sizes the footprint to the image proportions', () => {
    const img = disc(200, 100); // 2:1, wider than tall
    const m = run({ imgTopMode: 'carve', imgFit: 'width', topRotate: '90' }, img);
    // turned 90° the image runs along the stack: plate width / stack run follows 1:2
    const w = m.v.plateWidth - 2 * m.v.topMargin;
    const l = m.v.baseLength - 2 * m.v.endMargin - 2 * m.v.topMargin;
    expect(w / l).toBeCloseTo(0.5, 3);
    expect(m.ev.overrides.baseWidth).toBeTruthy();
    const win = m.sliced.top!;
    // the image now fills the footprint inside the margins (scale 0.9 of it)
    expect((win.r1 - win.r0) / w).toBeCloseTo(m.v.topScale, 2);
  });

  it('balloon profile inflates a flat silhouette from its edges', () => {
    const depthAt = (m: ReturnType<typeof run>, u: number) => {
      const plate = m.sliced.plates[Math.floor(m.sliced.plates.length / 2)].parts[0];
      return m.v.stackHeight - topAt(plate.shape, u)!;
    };
    const flat = run({ imgTopMode: 'carve', erosionAmp: '0', crest: '0', topDepth: '20', topSteps: '0', imgSmooth: '0', imgContrast: '1' }, disc());
    const balloon = run({ imgTopMode: 'carve', erosionAmp: '0', crest: '0', topDepth: '20', topSteps: '0', imgSmooth: '0', imgContrast: '1', topProfile: 'balloon' }, disc());
    // tone: one flat floor across the disc
    expect(depthAt(flat, 0)).toBeCloseTo(depthAt(flat, 20), 0);
    // balloon: deepest in the middle, easing out towards the rim
    const d0 = depthAt(balloon, 0), d1 = depthAt(balloon, 15), d2 = depthAt(balloon, 27);
    expect(d0).toBeGreaterThan(15);
    expect(d0).toBeGreaterThan(d1);
    expect(d1).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(0.5);
    expect(balloon.issues.filter((x) => x.severity === 'error')).toEqual([]);
  });
});
