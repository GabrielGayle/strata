import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_MIRRORS } from '../src/core/mapOverpassMirrors';
import {
  fetchOverpassDeduped,
  fetchOverpassWithMirrors,
  resetOverpassInflight,
} from '../src/core/mapOverpassFetch';

afterEach(() => {
  resetOverpassInflight();
  vi.unstubAllGlobals();
});

const QUERY = '[out:json][timeout:25];(way["highway"](1,2,3,4););out geom;';

function jsonOk(): Response {
  return new Response(JSON.stringify({ elements: [{ type: 'way', id: 1 }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Overpass mirror fallback', () => {
  it('walks mirrors after 502 and returns the first 200 JSON body', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === OVERPASS_MIRRORS[0]) return new Response('busy', { status: 502 });
      if (url === OVERPASS_MIRRORS[1]) return jsonOk();
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch;

    const data = (await fetchOverpassWithMirrors(QUERY, { fetchImpl, timeoutMs: 2_000 })) as {
      elements: { id: number }[];
    };
    expect(data.elements[0].id).toBe(1);
    expect(calls[0]).toBe(OVERPASS_MIRRORS[0]);
    expect(calls[1]).toBe(OVERPASS_MIRRORS[1]);
    expect(calls.length).toBe(2);
  });

  it('retries the mirror list a second time after a full pass of failures', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < OVERPASS_MIRRORS.length + 1) return new Response('busy', { status: 502 });
      return jsonOk();
    }) as unknown as typeof fetch;

    const data = await fetchOverpassWithMirrors(QUERY, { fetchImpl, timeoutMs: 2_000, mirrors: OVERPASS_MIRRORS.slice(0, 2) });
    expect((data as { elements: unknown[] }).elements).toHaveLength(1);
    expect(n).toBe(3);
  });

  it('dedupes concurrent identical queries to one upstream POST', async () => {
    let inflight = 0;
    let started = 0;
    const fetchImpl = vi.fn(async () => {
      started += 1;
      inflight += 1;
      expect(inflight).toBe(1);
      await new Promise((r) => setTimeout(r, 40));
      inflight -= 1;
      return jsonOk();
    }) as unknown as typeof fetch;

    const run = (q: string) => fetchOverpassWithMirrors(q, { fetchImpl, timeoutMs: 2_000, mirrors: [OVERPASS_MIRRORS[0]] });
    const [a, b] = await Promise.all([fetchOverpassDeduped(QUERY, run), fetchOverpassDeduped(QUERY, run)]);
    expect(started).toBe(1);
    expect(a).toBe(b);
  });
});
