import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDepthSettings, depthFromPhoto, depthToGray, parseDepthResponse, wakeDepth, type DepthData } from '../src/core/depth';

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
