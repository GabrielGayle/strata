import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDepthSettings, depthFromPhoto, depthToGray, parseDepthResponse, sampleDepthMetres, unreachableMessage, wakeDepth, type DepthData } from '../src/core/depth';
import {
  applyFlatCliPatch,
  autoFlatLevel,
  fillFlatDefaults,
  flattenBackgroundToPlate,
  isFlatDirty,
  isFlatEngaged,
  limitHeightSteps,
  parseFlatLevelFlag,
  percentileMetres,
  plateauMetres,
  resetFlatToAuto,
  resolveFlatLevel,
} from '../src/core/depthFlat';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

afterEach(() => vi.unstubAllGlobals());

describe('depth from photo', () => {
  it('parses a good response', () => {
    expect(parseDepthResponse({ png: PNG, width: 512, height: 384, cold_start: true })).toEqual({ png: PNG, width: 512, height: 384, coldStart: true });
  });

  it('rejects a response without a PNG and surfaces the server detail', () => {
    expect(() => parseDepthResponse({})).toThrow('no image');
    expect(() => parseDepthResponse({ detail: 'image must be under 15 MB' })).toThrow('15 MB');
  });

  it('posts the photo and mode as JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ png: PNG, width: 2, height: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await depthFromPhoto('data:image/jpeg;base64,AAAA', { url: 'https://x.modal.run/strata', mode: 'depth' });
    expect(r.png).toBe(PNG);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.modal.run/strata');
    expect(JSON.parse(String(init.body))).toMatchObject({ image: 'data:image/jpeg;base64,AAAA', mode: 'depth', return_depth: true });
  });

  it('turns an HTTP error into a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Could not read image' }), { status: 422 })));
    await expect(depthFromPhoto('x', { url: 'https://x' })).rejects.toThrow('Could not read image');
  });

  it('refuses to run without an endpoint', async () => {
    await expect(depthFromPhoto('x', { url: '' })).rejects.toThrow('not configured');
  });

  it('explains a blocked or offline service instead of "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(depthFromPhoto('x', { url: 'https://x' })).rejects.toThrow("Couldn't reach the depth service");
    expect(unreachableMessage('https://strata.cockpit.yoga')).toContain('from strata.cockpit.yoga');
  });

  it('wakes the service with one quiet GET every few minutes, ignoring failures', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const t = 1e12;
    expect(wakeDepth(undefined, t)).toBe(false);
    expect(wakeDepth('https://x.modal.run/strata', t)).toBe(true);
    expect(wakeDepth('https://x.modal.run/strata', t + 60_000)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.modal.run/strata');
    expect(init).toMatchObject({ method: 'GET', mode: 'no-cors' });
    await Promise.resolve();
    expect(wakeDepth('https://x.modal.run/strata', t + 5 * 60_000)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// 4×1 depth map: 1 m, 2 m, 4 m, no depth; service range 1..5 m
function u16(metres: (number | null)[], lo: number, hi: number): string {
  const b = new Uint8Array(metres.length * 2);
  metres.forEach((m, i) => {
    const q = m === null ? 0 : 1 + Math.round(((m - lo) / (hi - lo)) * 65534);
    b[i * 2] = q & 255;
    b[i * 2 + 1] = q >> 8;
  });
  return btoa(String.fromCharCode(...b));
}

const RAW = { w: 4, h: 1, minM: 1, maxM: 5, nearM: 1, farM: 4, data: u16([1, 2, 4, null], 1, 5) };
const map = (patch: Partial<DepthData['settings']> = {}): DepthData => ({ ...RAW, settings: { ...defaultDepthSettings(RAW), ...patch } });
const near = (g: { data: Float32Array }) => Array.from(g.data, (v) => +v.toFixed(3));

describe('depth shaping', () => {
  it('reads the metric depth from the service reply', () => {
    const r = parseDepthResponse({
      png: PNG,
      depth: { w: 4, h: 1, min_m: 1, max_m: 5, near_m: 1, far_m: 4, data: RAW.data, mask: null, focal_length_px: 512 },
    });
    expect(r.depth).toMatchObject({ w: 4, h: 1, minM: 1, maxM: 5, nearM: 1, farM: 4, focalLengthPx: 512 });
    expect(r.depth?.mask).toBeUndefined();
    expect(parseDepthResponse({ png: PNG }).depth).toBeUndefined();
  });

  it('maps near to dark and far / missing depth to white, evenly in 1/distance', () => {
    // perspective: 1/1=1 → 1, 1/2 → (0.5-0.25)/(0.75) = 1/3, 1/4 → 0
    expect(near(depthToGray(map()))).toEqual([0, 0.667, 1, 1]);
  });

  it('linear spacing is even in metres', () => {
    expect(near(depthToGray(map({ spacing: 'linear' })))).toEqual([0, 0.333, 1, 1]);
  });

  it('far cuts the background and near clamps to full height', () => {
    expect(near(depthToGray(map({ near: 2, far: 3 })))).toEqual([0, 0, 1, 1]);
  });

  it('curve and invert shape the height', () => {
    expect(near(depthToGray(map({ spacing: 'linear', curve: 2 })))).toEqual([0, 0.556, 1, 1]);
    expect(near(depthToGray(map({ invert: true })))).toEqual([1, 0.333, 0, 0]);
  });

  it('applies the subject matte unless turned off', () => {
    const mask = btoa(String.fromCharCode(255, 0, 255, 255));
    expect(near(depthToGray({ ...map(), mask }))).toEqual([0, 1, 1, 1]);
    expect(near(depthToGray({ ...map({ matte: false }), mask }))).toEqual([0, 0.667, 1, 1]);
  });

  it('resolution caps the grid size', () => {
    const big = { ...RAW, w: 40, h: 20, data: u16(Array.from({ length: 800 }, (_, i) => 1 + (i % 40) / 10), 1, 5) };
    const g = depthToGray({ ...big, settings: { ...defaultDepthSettings(big), resolution: 16 } });
    expect([g.w, g.h]).toEqual([16, 8]);
    expect(g.data.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

describe('background to plate flat', () => {
  it('does not change a legacy depth map until the user engages the feature', () => {
    expect(near(depthToGray(map()))).toEqual([0, 0.667, 1, 1]);
    expect(isFlatEngaged(defaultDepthSettings(RAW))).toBe(false);
    expect(near(depthToGray(map({ flatLevelMode: 'off', flatLevel: 1.2, flatLevelOverride: true })))).toEqual([0, 0.667, 1, 1]);
  });

  it('flattens everything at or beyond the level to one plate', () => {
    const g = depthToGray(map({ spacing: 'linear', flatLevel: 2, flatLevelOverride: true, flatLevelMode: 'auto' }));
    // linear: 1 m → 0, 2 m and 4 m share the 2 m plate, missing stays white
    expect(near(g)).toEqual([0, 0.333, 0.333, 1]);
  });

  it('edge ease blends into the flat region by a measurable amount', () => {
    const hard = near(depthToGray(map({ spacing: 'linear', flatLevel: 3, flatLevelOverride: true, flatLevelMode: 'auto', edgeEase: 0 })));
    const ease = near(depthToGray(map({ spacing: 'linear', flatLevel: 3, flatLevelOverride: true, flatLevelMode: 'auto', edgeEase: 0.5 })));
    // 2 m sits in the falloff: pulled toward the plate, so the grey moves toward the far plate
    expect(ease[1] - hard[1]).toBeGreaterThan(0.08);
    expect(ease[0]).toBeCloseTo(hard[0], 3);
  });

  it('flatten-negative floors dips below the plate by a measurable amount', () => {
    const height = new Float32Array([1, 0.2, 0]);
    const keep = new Float32Array([1, 1, 0]);
    const metres = new Float32Array([1, 1.2, 0]);
    const plate = heightOfLinear(2, 1, 4);
    flattenBackgroundToPlate(height, keep, metres, 2, { ...defaultDepthSettings(RAW), flatNegative: true, flatLevelMode: 'auto' }, { near: 1, far: 4, persp: false });
    expect(height[1]).toBeGreaterThanOrEqual(plate - 1e-6);
    expect(height[1] - 0.2).toBeGreaterThan(0.3);
    expect(keep[1]).toBe(1);
    expect(height[2]).toBe(0);
  });

  it('step limit caps adjacent height changes and moves the cliff', () => {
    const cliff = new Float32Array([1, 1, 0, 0]);
    const out = limitHeightSteps(cliff, 4, 1, 0.2);
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(Math.abs(out[1] - cliff[1]) + Math.abs(out[2] - cliff[2])).toBeGreaterThan(0.15);
    const g = depthToGray(
      map({
        spacing: 'linear',
        flatLevel: 2,
        flatLevelOverride: true,
        flatLevelMode: 'auto',
        stepLimit: 0.08,
        matte: false,
      }),
    );
    const h = Array.from(g.data, (v) => 1 - v);
    for (let i = 1; i < 3; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThanOrEqual(0.08 + 0.02);
  });

  it('map faces bypass image flattening', () => {
    const patched = map({ spacing: 'linear', flatLevel: 1.2, flatLevelOverride: true, flatLevelMode: 'auto', edgeEase: 1, stepLimit: 0.05, flatNegative: true });
    const asMap: DepthData = {
      ...patched,
      mapOrtho: { source: 'map', widthM: 10, heightM: 8, reliefM: 4, bboxKm: '0.01 × 0.01 km' },
    };
    expect(near(depthToGray(asMap))).toEqual(near(depthToGray(map({ spacing: 'linear' }))));
  });

  it('never clobbers user-set flat values when filling defaults', () => {
    const user = {
      ...defaultDepthSettings(RAW),
      flatLevel: 3.25,
      flatLevelMode: 'percentile' as const,
      flatLevelOverride: true,
      flatPercentile: 72,
      edgeEase: 0.4,
      stepLimit: 0.1,
      flatNegative: true,
    };
    const filled = fillFlatDefaults(user);
    expect(filled.flatLevel).toBe(3.25);
    expect(filled.flatLevelMode).toBe('percentile');
    expect(filled.flatLevelOverride).toBe(true);
    expect(filled.flatPercentile).toBe(72);
    expect(filled.edgeEase).toBe(0.4);
    expect(filled.stepLimit).toBe(0.1);
    expect(filled.flatNegative).toBe(true);
    expect(fillFlatDefaults(defaultDepthSettings(RAW)).flatLevelOverride).toBe(false);
    expect(isFlatEngaged(fillFlatDefaults(defaultDepthSettings(RAW)))).toBe(false);
  });

  it('Reset to auto clears every flat field, not only the locked level', () => {
    const dirty = {
      ...defaultDepthSettings(RAW),
      flatLevel: 3.25,
      flatLevelMode: 'percentile' as const,
      flatLevelOverride: true,
      flatPercentile: 60,
      edgeEase: 0.4,
      stepLimit: 0.1,
      flatNegative: true,
    };
    expect(isFlatDirty(dirty)).toBe(true);
    const reset = resetFlatToAuto(dirty);
    expect(reset.flatLevelMode).toBe('auto');
    expect(reset.flatLevelOverride).toBe(false);
    expect(reset.flatLevel).toBeUndefined();
    expect(reset.flatPercentile).toBe(85);
    expect(reset.edgeEase).toBe(0);
    expect(reset.stepLimit).toBe(0);
    expect(reset.flatNegative).toBe(false);
    expect(isFlatDirty(reset)).toBe(false);
    expect(isFlatEngaged(reset)).toBe(true);
  });

  it('override wins over auto / plateau / percentile rebuilds', () => {
    const metres = new Float32Array([1, 1, 1, 8, 8, 8, 8, 8]);
    const d = { minM: 1, maxM: 8, farM: 8 };
    const locked = resolveFlatLevel(metres, d, { ...defaultDepthSettings({ nearM: 1, farM: 8 }), flatLevel: 2.5, flatLevelOverride: true, flatLevelMode: 'plateau' });
    expect(locked.levelM).toBe(2.5);
    expect(locked.overridden).toBe(true);
    const auto = resolveFlatLevel(metres, d, { ...defaultDepthSettings({ nearM: 1, farM: 8 }), flatLevelMode: 'auto' });
    expect(auto.overridden).toBe(false);
    expect(auto.levelM).not.toBe(2.5);
  });

  it('plateau and percentile pick a far background level', () => {
    const vals = [1, 1, 1, 2, 7.5, 7.6, 7.7, 7.8, 7.9, 8, 8, 8, 8, 8];
    const plat = plateauMetres(vals, 1, 8);
    const perc = percentileMetres(vals, 80);
    expect(plat).toBeGreaterThan(5);
    expect(perc).toBeGreaterThan(6);
    expect(autoFlatLevel(vals, 1, 8, 8)).toBeGreaterThan(5);
  });

  it('percentile 60 vs 85 walk the depth span, not the backdrop pixel cluster', () => {
    const vals: number[] = [];
    for (let i = 0; i < 30; i++) vals.push(2);
    for (let i = 0; i < 70; i++) vals.push(8);
    const p60 = percentileMetres(vals, 60);
    const p85 = percentileMetres(vals, 85);
    expect(p85 - p60).toBeGreaterThan(1);
    expect(p60).toBeCloseTo(2 + 0.6 * 6, 5);
    expect(p85).toBeCloseTo(2 + 0.85 * 6, 5);
  });

  it('eyedropper samples metres at a click', () => {
    expect(sampleDepthMetres(map(), 0, 0)).toBeCloseTo(1, 2);
    expect(sampleDepthMetres(map(), 0.4, 0)).toBeCloseTo(2, 2);
    expect(sampleDepthMetres(map(), 1, 0)).toBeNull();
  });

  it('CLI patch sets the override flag for a metre value and Reset-to-auto clears it', () => {
    const base = defaultDepthSettings(RAW);
    const locked = applyFlatCliPatch(base, { flatLevel: 3.1, edgeEase: 0.2, stepLimit: 0.05, flatNegative: true });
    expect(locked.flatLevel).toBe(3.1);
    expect(locked.flatLevelOverride).toBe(true);
    expect(locked.edgeEase).toBe(0.2);
    expect(locked.stepLimit).toBe(0.05);
    expect(locked.flatNegative).toBe(true);
    const reset = resetFlatToAuto(locked);
    expect(reset.flatLevelOverride).toBe(false);
    expect(reset.flatLevelMode).toBe('auto');
    expect(reset.flatLevel).toBeUndefined();
    expect(reset.edgeEase).toBe(0);
    expect(reset.stepLimit).toBe(0);
    expect(reset.flatNegative).toBe(false);
    expect(parseFlatLevelFlag('off')).toBe('off');
    expect(parseFlatLevelFlag('plateau')).toBe('plateau');
    expect(parseFlatLevelFlag('4.5')).toBe(4.5);
    expect(applyFlatCliPatch(locked, { flatLevel: 'off' }).flatLevelMode).toBe('off');
  });
});

function heightStats(g: { w: number; h: number; data: Float32Array }, invert: boolean, subject: (x: number, y: number) => boolean) {
  let subMax = 0;
  let backMin = 1;
  let backN = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const hgt = invert ? g.data[y * g.w + x] : 1 - g.data[y * g.w + x];
      if (subject(x, y)) {
        if (hgt > subMax) subMax = hgt;
      } else {
        backN++;
        if (hgt < backMin) backMin = hgt;
      }
    }
  }
  return { subMax, backMin, backN };
}

function domeRaw() {
  const w = 32;
  const h = 32;
  const metres: number[] = [];
  const cx = 15.5;
  const cy = 15.5;
  const rad = 8;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - cx, y - cy) / rad;
      if (r < 1) metres.push(1.5 + r * r * 1.5);
      else metres.push(7 + 2 * ((x + y) % 7) / 6);
    }
  }
  return {
    w,
    h,
    minM: 1,
    maxM: 10,
    nearM: 1,
    farM: 10,
    data: u16(metres, 1, 10),
    inDome: (x: number, y: number) => Math.hypot(x - cx, y - cy) / rad < 1,
  };
}

describe('flat level on a dome in front of a backdrop', () => {
  const raw = domeRaw();
  const base = {
    ...raw,
    settings: { ...defaultDepthSettings(raw), spacing: 'linear' as const, invert: true, matte: false, resolution: 32 },
  };
  const inDome = (x: number, y: number) => raw.inDome(x, y);

  it('Off keeps a low backdrop; Auto raises it and keeps the dome peak', () => {
    const off = heightStats(depthToGray(base), true, inDome);
    const on = heightStats(depthToGray({ ...base, settings: { ...base.settings, flatLevelMode: 'auto' } }), true, inDome);
    expect(on.backMin).toBeGreaterThan(off.backMin + 0.04);
    expect(on.subMax).toBeGreaterThan(off.subMax * 0.9);
    expect(on.subMax).toBeGreaterThan(on.backMin + 0.2);
  });

  it('percentile 60 vs 85 change the backdrop plate', () => {
    const p60 = heightStats(depthToGray({ ...base, settings: { ...base.settings, flatLevelMode: 'percentile', flatPercentile: 60 } }), true, inDome);
    const p85 = heightStats(depthToGray({ ...base, settings: { ...base.settings, flatLevelMode: 'percentile', flatPercentile: 85 } }), true, inDome);
    expect(Math.abs(p60.backMin - p85.backMin)).toBeGreaterThan(0.04);
    expect(p60.subMax).toBeGreaterThan(0.7);
    expect(p85.subMax).toBeGreaterThan(0.7);
  });
});

function heightOfLinear(m: number, near: number, far: number) {
  return Math.min(1, Math.max(0, (far - m) / (far - near)));
}
