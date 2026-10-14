import { afterEach, describe, expect, it, vi } from 'vitest';
import { depthFromPhoto, parseDepthResponse } from '../src/core/depth';

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
    expect(JSON.parse(String(init.body))).toMatchObject({ image: 'data:image/jpeg;base64,AAAA', mode: 'depth' });
  });

  it('turns an HTTP error into a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Could not read image' }), { status: 422 })));
    await expect(depthFromPhoto('x', { url: 'https://x' })).rejects.toThrow('Could not read image');
  });

  it('refuses to run without an endpoint', async () => {
    await expect(depthFromPhoto('x', { url: '' })).rejects.toThrow('not configured');
  });
});
