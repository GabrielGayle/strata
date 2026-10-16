import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDepthSettings, depthFromPhoto, depthToGray, parseDepthResponse, sampleDepthMetres, wakeDepth, type DepthData } from '../src/core/depth';
import {
  applyFlatCliPatch,
  autoFlatLevel,
  fillFlatDefaults,
  flattenBackgroundToPlate,
  limitHeightSteps,
  parseFlatLevelFlag,
  percentileMetres,
  plateauMetres,
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
  });

  it('flattens everything at or beyond the level to one plate', () => {
    const g = depthToGray(map({ spacing: 'linear', flatLevel: 2, flatLevelOverride: true, flatLevelMode: 'auto' }));
    // linear: 1 m → 0, 2 m and 4 m share the 2 m plate, missing stays white
    expect(near(g)).toEqual([0, 0.333, 0.333, 1]);
  });

  it('edge ease blends into the flat region', () => {
    const hard = near(depthToGray(map({ spacing: 'linear', flatLevel: 3, flatLevelOverride: true, flatLevelMode: 'auto', edgeEase: 0 })));
    const ease = near(depthToGray(map({ spacing: 'linear', flatLevel: 3, flatLevelOverride: true, flatLevelMode: 'auto', edgeEase: 0.5 })));
    expect(hard).not.toEqual(ease);
    // 2 m sits in the falloff: pulled toward the plate, so the grey moves toward the far plate
    expect(ease[1]).toBeGreaterThan(hard[1]);
  });

  it('flatten-negative floors dips below the plate', () => {
    const height = new Float32Array([1, 0.2, 0]);
    const keep = new Float32Array([1, 1, 0]);
    const metres = new Float32Array([1, 1.2, 0]);
    flattenBackgroundToPlate(height, keep, metres, 2, { ...defaultDepthSettings(RAW), flatNegative: true, flatLevelMode: 'auto' }, { near: 1, far: 4, persp: false });
    expect(height[1]).toBeGreaterThanOrEqual(heightOfLinear(2, 1, 4) - 1e-6);
  });

  it('step limit caps adjacent height changes', () => {
    const out = limitHeightSteps(new Float32Array([0, 1, 0, 1]), 4, 1, 0.25);
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(0.25 + 1e-6);
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
    expect(perc).toBeGreaterThan(7);
    expect(autoFlatLevel(vals, 1, 8, 8)).toBeGreaterThan(5);
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
    const reset = applyFlatCliPatch(locked, { flatLevel: 'auto' });
    expect(reset.flatLevelOverride).toBe(false);
    expect(reset.flatLevelMode).toBe('auto');
    expect(reset.flatLevel).toBe(3.1);
    expect(parseFlatLevelFlag('plateau')).toBe('plateau');
    expect(parseFlatLevelFlag('4.5')).toBe(4.5);
  });
});

function heightOfLinear(m: number, near: number, far: number) {
  return Math.min(1, Math.max(0, (far - m) / (far - near)));
}
