import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_MIRRORS } from '../src/core/mapOverpassMirrors';
import {
  fetchOverpassDeduped,
  fetchOverpassWithMirrors,
  resetOverpassInflight,
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
  it('uses zero browser retry under vitest so suites never really sleep', () => {
    expect(resolveOverpassBrowserRetryMs()).toBe(0);
    setOverpassTestDelays({ timeoutMs: 1, browserRetryMs: 0 });
    expect(resolveOverpassBrowserRetryMs()).toBe(0);
  });

  it('tries mirrors one at a time and stops at the first answer', async () => {
    let inflight = 0;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      inflight += 1;
      expect(inflight).toBe(1);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      if (url === OVERPASS_MIRRORS[0]) return new Response('busy', { status: 502 });
      return jsonOk();
    }) as unknown as typeof fetch;

    const data = (await fetchOverpassWithMirrors(QUERY, {
      fetchImpl,
      timeoutMs: 2_000,
      mirrors: OVERPASS_MIRRORS.slice(0, 4),
    })) as { elements: { id: number }[] };
    expect(data.elements[0].id).toBe(1);
    expect(calls).toEqual(OVERPASS_MIRRORS.slice(0, 2));
  });

  it('aborts a hung mirror at its timeout and moves to the next', async () => {
    const aborted: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === OVERPASS_MIRRORS[0]) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push(url);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return jsonOk();
    }) as unknown as typeof fetch;

    const data = await fetchOverpassWithMirrors(QUERY, { fetchImpl, timeoutMs: 20, mirrors: OVERPASS_MIRRORS.slice(0, 2) });
    expect((data as { elements: unknown[] }).elements).toHaveLength(1);
    expect(aborted).toEqual([OVERPASS_MIRRORS[0]]);
  });

  it('starts the next mirror beside a silent one and aborts the slow one when the next answers', async () => {
    const aborted: string[] = [];
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === OVERPASS_MIRRORS[0]) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push(url);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return jsonOk();
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    const data = await fetchOverpassWithMirrors(QUERY, {
      fetchImpl,
      timeoutMs: 5_000,
      hedgeMs: 20,
      mirrors: OVERPASS_MIRRORS.slice(0, 3),
    });
    expect((data as { elements: unknown[] }).elements).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(calls).toEqual(OVERPASS_MIRRORS.slice(0, 2));
    expect(aborted).toEqual([OVERPASS_MIRRORS[0]]);
  });

  it('stops at a 400: a bad query costs one upstream request', async () => {
    const fetchImpl = vi.fn(async () => new Response('parse error', { status: 400 })) as unknown as typeof fetch;
    await expect(
      fetchOverpassWithMirrors(QUERY, { fetchImpl, timeoutMs: 2_000, mirrors: OVERPASS_MIRRORS }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('walks every mirror once and reports the last failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchOverpassWithMirrors(QUERY, { fetchImpl, timeoutMs: 2_000, mirrors: OVERPASS_MIRRORS.slice(0, 3) }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('dedupes concurrent identical queries to one upstream walk', async () => {
    let started = 0;
    const fetchImpl = vi.fn(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 40));
      return jsonOk();
    }) as unknown as typeof fetch;

    const run = (q: string) => fetchOverpassWithMirrors(q, { fetchImpl, timeoutMs: 2_000, mirrors: [OVERPASS_MIRRORS[0]] });
    const [a, b] = await Promise.all([fetchOverpassDeduped(QUERY, run), fetchOverpassDeduped(QUERY, run)]);
    expect(started).toBe(1);
    expect(a).toBe(b);
  });
});
