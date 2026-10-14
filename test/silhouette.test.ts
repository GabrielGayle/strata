import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { silhouetteMask, type Gray } from '../src/core/image';
import { footprintSpans } from '../src/core/slicer';
import { rect } from '../src/core/geom2d';

// a transparent PNG holding a dark disc
function cutout(w = 120, h = 60, transparent = true): Gray {
  const data = new Float32Array(w * h).fill(1);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (Math.hypot(x - w / 2, y - h / 2) < h * 0.4) {
        data[y * w + x] = 0.3;
        alpha[y * w + x] = 1;
      }
  return transparent ? { w, h, data, alpha } : { w, h, data };
}

const run = (img: Gray, extra: Record<string, string> = {}) => {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgTopMode: 'carve', topDepth: '5', topSteps: '1', imgSmooth: '0', imgContrast: '1', ...extra };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: img, insMesh: null, srcMesh: null });
};
const widths = (m: ReturnType<typeof run>) => m.sliced.plates.map((pl) => (pl.parts.length ? Math.max(...pl.parts.map((q) => q.bbox.maxX)) - Math.min(...pl.parts.map((q) => q.bbox.minX)) : 0));

describe('PNG silhouette outline', () => {
  it('reads the mask from alpha, and from a light background only in matte mode', () => {
    expect(silhouetteMask(cutout(), 'alpha')).toBeTruthy();
    expect(silhouetteMask(cutout(120, 60, false), 'alpha')).toBeNull();
    const m = silhouetteMask(cutout(120, 60, false), 'matte')!;
    expect(m.data[30 * 120 + 60]).toBe(1);
    expect(m.data[0]).toBe(0);
  });

  it('keeps light areas inside a matted shape', () => {
    const g = cutout(120, 60, false);
    g.data[30 * 120 + 60] = 1; // a white "eye" in the middle
    expect(silhouetteMask(g, 'matte')!.data[30 * 120 + 60]).toBe(1);
  });

  it('trims the plates to the disc, wide in the middle and narrow at the ends', () => {
    const plain = widths(run(cutout(), { topOutline: 'off' }));
    const w = widths(run(cutout()));
    const mid = Math.floor(w.length / 2);
    expect(plain.every((x) => x === plain[mid])).toBe(true);
    expect(w[mid]).toBeLessThan(plain[mid]);
    expect(w[mid]).toBeGreaterThan(w[1]);
    expect(w[0]).toBeLessThan(w[mid] * 0.6);
  });

  it('chokes the outline in and spreads it out', () => {
    const mid = (m: ReturnType<typeof run>) => widths(m)[Math.floor(m.sliced.plates.length / 2)];
    const base = mid(run(cutout()));
    // the middle plate runs just off the disc centre, so its chord moves a touch more than 2 × choke
    expect(Math.abs(mid(run(cutout(), { topChoke: '10' })) - (base - 20))).toBeLessThan(2);
    expect(Math.abs(mid(run(cutout(), { topChoke: '-5' })) - (base + 10))).toBeLessThan(2);
  });

  it('leaves no slivers where the picture fades out at the trimmed plate ends', () => {
    // a flower whose shading lightens towards its anti-aliased edge, like a real cut-out PNG
    const W = 256;
    const data = new Float32Array(W * W).fill(1), alpha = new Float32Array(W * W);
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const dx = x - W / 2, dy = y - W / 2, r = Math.hypot(dx, dy);
        const R = (0.3 + 0.12 * Math.cos(5 * Math.atan2(dy, dx))) * W;
        const al = Math.max(0, Math.min(1, R - r + 0.5));
        const lum = Math.min(1, 0.2 + 0.8 * Math.max(0, 1 - (R - r) / 6));
        data[y * W + x] = lum * al + 1 - al;
        alpha[y * W + x] = al;
      }
    for (const extra of [{}, { topSteps: '0' }, { topChoke: '6' }] as Record<string, string>[]) {
      const m = run({ w: W, h: W, data, alpha }, { baseLength: '500', baseWidth: '500', plateWidth: '460', topScale: '1', imgSmooth: '1', topDepth: '18', topSteps: '4', ...extra });
      expect(m.sliced.parts.length).toBeGreaterThan(20);
      expect(m.issues.filter((i) => i.type !== 'label')).toEqual([]);
    }
  });

  it('leaves an opaque image alone', () => {
    const a = widths(run(cutout(120, 60, false)));
    const b = widths(run(cutout(120, 60, false), { topOutline: 'off' }));
    expect(a).toEqual(b);
  });

  it('finds the spans of a plate line through a footprint', () => {
    const plane = { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] };
    const foot = [...rect(-10, -5, -2, 5), ...rect(3, -5, 8, 5)];
    const s = footprintSpans(plane, foot);
    expect(s.length).toBe(2);
    expect(s[0][0]).toBeCloseTo(-10);
    expect(s[1][1]).toBeCloseTo(8);
  });
});

describe('PNG silhouette outline, flat stack', () => {
  it('trims every flat layer to the shape', () => {
    const W = 120;
    const data = new Float32Array(W * W).fill(1), alpha = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - W / 2, y - W / 2) < W * 0.4) { data[y * W + x] = 0.3; alpha[y * W + x] = 1; }
    const area = (outline: string) => {
      const p = newProject();
      p.params = { ...p.params, sliceMode: 'flat', insShape: 'none', imgTopMode: 'carve', topOutline: outline, baseLength: '400', baseWidth: '400', plateWidth: '360' };
      const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: { w: W, h: W, data, alpha }, insMesh: null, srcMesh: null });
      return m.sliced.plates[0].parts.reduce((a, q) => a + q.area, 0);
    };
    const full = area('off'), disc = area('alpha');
    expect(disc).toBeGreaterThan(0);
    expect(disc).toBeLessThan(full * 0.8);
  });
});
