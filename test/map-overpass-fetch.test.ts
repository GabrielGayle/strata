import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_MIRRORS } from '../src/core/mapOverpassMirrors';
import {
  fetchOverpassDeduped,
  fetchOverpassWithMirrors,
  resetOverpassInflight,
  resolveOverpassBackoffMs,
  resolveOverpassBrowserRetryMs,
  setOverpassTestDelays,
} from '../src/core/mapOverpassFetch';

afterEach(() => {
  resetOverpassInflight();
  setOverpassTestDelays(null);
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
  it('uses zero backoff and browser retry under vitest so suites never really sleep', () => {
    expect(resolveOverpassBackoffMs()).toEqual([0, 0]);
    expect(resolveOverpassBrowserRetryMs()).toBe(0);
    setOverpassTestDelays({ backoffMs: [0, 0], timeoutMs: 1, browserRetryMs: 0 });
    expect(resolveOverpassBackoffMs()).toEqual([0, 0]);
    expect(resolveOverpassBrowserRetryMs()).toBe(0);
  });

  it('returns the first 200 JSON among parallel mirrors after others 502', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === OVERPASS_MIRRORS[0]) {
        await new Promise((r) => setTimeout(r, 40));
        return new Response('busy', { status: 502 });
      }
      if (url === OVERPASS_MIRRORS[1]) return jsonOk();
      await new Promise((r) => setTimeout(r, 80));
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch;

    const data = (await fetchOverpassWithMirrors(QUERY, {
      fetchImpl,
      timeoutMs: 2_000,
      backoffMs: [0],
      mirrors: OVERPASS_MIRRORS.slice(0, 3),
    })) as { elements: { id: number }[] };
    expect(data.elements[0].id).toBe(1);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('retries a second parallel pass after every mirror fails', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n <= 2) return new Response('busy', { status: 502 });
      return jsonOk();
    }) as unknown as typeof fetch;

    const data = await fetchOverpassWithMirrors(QUERY, {
      fetchImpl,
      timeoutMs: 2_000,
      mirrors: OVERPASS_MIRRORS.slice(0, 2),
      backoffMs: [0, 0],
    });
    expect((data as { elements: unknown[] }).elements).toHaveLength(1);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('dedupes concurrent identical queries to one upstream race', async () => {
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

    const run = (q: string) =>
      fetchOverpassWithMirrors(q, { fetchImpl, timeoutMs: 2_000, mirrors: [OVERPASS_MIRRORS[0]], backoffMs: [0] });
    const [a, b] = await Promise.all([fetchOverpassDeduped(QUERY, run), fetchOverpassDeduped(QUERY, run)]);
    expect(started).toBe(1);
    expect(a).toBe(b);
  });
});
