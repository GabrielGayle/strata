import { describe, expect, it } from 'vitest';
import { applyAutoDimensionCli } from '../src/cli';
import { DEFAULT_HFOV_DEG, focalLengthPx, measureDepthExtent, previewAutoDimension } from '../src/core/autoDimension';
import { defaultDepthSettings, type DepthData } from '../src/core/depth';
import { newProject } from '../src/core/project';
import { createPipeline } from '../src/core/pipeline';

function u16(metres: (number | null)[], lo: number, hi: number, w: number, h: number): string {
  const b = new Uint8Array(w * h * 2);
  metres.forEach((m, i) => {
    const q = m === null ? 0 : 1 + Math.round(((m - lo) / (hi - lo)) * 65534);
    b[i * 2] = q & 255;
    b[i * 2 + 1] = q >> 8;
  });
  return btoa(String.fromCharCode(...b));
}

function depthMap(
  w: number,
  h: number,
  zAt: (u: number, v: number) => number | null,
  patch: Partial<DepthData> = {},
): DepthData {
  const minM = 1;
  const maxM = 20;
  const cells: (number | null)[] = [];
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) cells.push(zAt(u, v));
  return {
    w,
    h,
    minM,
    maxM,
    nearM: 1,
    farM: 15,
    data: u16(cells, minM, maxM, w, h),
    settings: defaultDepthSettings({ nearM: 1, farM: 15 }),
    ...patch,
  };
}

describe('auto dimension geometry', () => {
  it('resolves focal length from Depth Pro, then EXIF, then 60° HFOV', () => {
    const base = { w: 100, h: 80 };
    expect(focalLengthPx({ ...base, focalLengthPx: 120 }).source).toBe('depthPro');
    expect(focalLengthPx({ ...base, exifFocalLengthPx: 90 }).f).toBe(90);
    const fov = focalLengthPx(base);
    expect(fov.source).toBe('fov60');
    expect(fov.f).toBeCloseTo(100 / (2 * Math.tan((DEFAULT_HFOV_DEG * Math.PI) / 360)), 4);
  });

  it('back-projects a flat wall at known depth to the correct width', () => {
    const f = 200;
    const z = 10;
    const w = 40;
    const h = 10;
    const d = depthMap(w, h, () => z, { focalLengthPx: f });
    const e = measureDepthExtent(d)!;
    const expectedW = ((w - 1) * z) / f;
    expect(e.widthM).toBeCloseTo(expectedW, 1);
    expect(e.deltaZM).toBeLessThan(0.01);
  });

  it('uses 2–98% percentiles and ignores pixels beyond the depth ceiling', () => {
    const f = 100;
    const d = depthMap(20, 10, (u) => (u < 2 ? null : 10), { focalLengthPx: f, farM: 12 });
    const e = measureDepthExtent(d)!;
    expect(e.sampleCount).toBe(18 * 10);
    expect(e.deltaZM).toBeLessThan(0.5);
  });

  it('computes relief-to-width ratio', () => {
    const f = 150;
    const d = depthMap(30, 20, (_u, v) => 8 + v * 0.2, { focalLengthPx: f });
    const e = measureDepthExtent(d)!;
    expect(e.reliefToWidth).toBeGreaterThan(0);
    expect(e.aspectWH).toBeGreaterThan(0.5);
  });
});

describe('auto dimension mapping', () => {
  it('sets top aspect and impression depth from depth', () => {
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgTopMode: 'carve' };
    const f = 120;
    const depth = depthMap(32, 16, () => 6, { focalLengthPx: f });
    const preview = previewAutoDimension('top', depth, p.params, { reliefExaggeration: 1 });
    expect(preview.ok).toBe(true);
    expect(preview.patch.imgFit).toBe('width');
    expect(Number(preview.patch.topDepth)).toBeGreaterThan(0);
    const m = createPipeline()({ ...p, params: { ...p.params, ...preview.patch } }, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
    expect(m.v.topDepth).toBeGreaterThan(0);
  });

  it('sets side length and imgRange from depth', () => {
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgSideMode: 'heightmap', stackSource: 'strata' };
    const depth = depthMap(40, 10, (_u, v) => 5 + v * 0.5, { focalLengthPx: 100 });
    const preview = previewAutoDimension('side', depth, p.params);
    expect(preview.ok).toBe(true);
    expect(preview.patch.imgSideFit).toBe('length');
    expect(Number(preview.patch.imgRange)).toBeGreaterThan(0);
  });

  it('reports clamping when relief exceeds topDepth max', () => {
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', baseLength: '2000', baseWidth: '2000', imgTopMode: 'carve' };
    const depth = depthMap(10, 10, () => 2, { focalLengthPx: 50 });
    const preview = previewAutoDimension('top', depth, p.params, { reliefExaggeration: 50 });
    expect(preview.clamped).toContain('topDepth');
  });
});

describe('cli auto-dimension', () => {
  it('applies per-face patches when depth is present', () => {
    const p = newProject();
    const depth = depthMap(16, 16, () => 4, { focalLengthPx: 80 });
    p.images.top = { name: 't.png', dataUrl: 'data:image/png;base64,aa', depth };
    p.params = { ...p.params, insShape: 'none', imgTopMode: 'carve' };
    const issues = applyAutoDimensionCli(p, ['top'], 1);
    expect(issues.some((i) => i.level === 'error')).toBe(false);
    expect(p.params.imgFit).toBe('width');
  });

  it('warns when a face has no depth data', () => {
    const p = newProject();
    const issues = applyAutoDimensionCli(p, ['front'], 1);
    expect(issues[0]?.message).toMatch(/no metric depth/i);
  });
});
