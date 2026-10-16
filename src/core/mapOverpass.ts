// Overpass API client with polite User-Agent and on-disk cache (offline tests use fixtures).
import { cachedMapJson, readMapCacheJson, writeMapCacheJson } from './mapCache';
import { fetchOverpassDeduped, fetchOverpassWithMirrors, STRATA_OVERPASS_UA } from './mapOverpassFetch';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export { STRATA_OVERPASS_UA };

export type OverpassFetcher = (query: string) => Promise<unknown>;

let fetcherOverride: OverpassFetcher | null = null;

export function setOverpassFetcher(fetch: OverpassFetcher | null): void {
  fetcherOverride = fetch;
}

export function readOverpassCache(cacheDir: string, query: string): unknown | null {
  return readMapCacheJson(cacheDir, 'overpass', query);
}

export function writeOverpassCache(cacheDir: string, query: string, data: unknown): void {
  writeMapCacheJson(cacheDir, 'overpass', query, data);
}

async function postBrowserProxy(query: string): Promise<unknown> {
  const res = await fetch('/api/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass proxy failed (${res.status})`);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Browser: local Vite/Vercel proxy (server already walks mirrors). Node CLI: mirror list. */
export async function defaultOverpassFetch(query: string): Promise<unknown> {
  if (typeof window !== 'undefined') {
    return fetchOverpassDeduped(query, async (q) => {
      try {
        return await postBrowserProxy(q);
      } catch (e) {
        await sleep(500);
        try {
          return await postBrowserProxy(q);
        } catch {
          throw e;
        }
      }
    });
  }
  return fetchOverpassDeduped(query, (q) => fetchOverpassWithMirrors(q));
}

export function overpassQueryForBbox(bbox: [number, number, number, number], features: string[] = []): string {
  const [w, s, e, n] = bbox;
  const want = new Set(features.map((f) => f.toLowerCase()));
  const golf = want.has('golf') || want.has('fairway') || want.has('green');
  const ski = want.has('ski') || want.has('piste') || want.has('alpine');
  const buildings = want.has('buildings') || want.has('building');
  const blocks = [
    `  way["highway"](${s},${w},${n},${e});`,
    `  way["natural"="water"](${s},${w},${n},${e});`,
    `  way["waterway"](${s},${w},${n},${e});`,
    `  way["railway"](${s},${w},${n},${e});`,
  ];
  if (golf) {
    blocks.push(`  way["golf"](${s},${w},${n},${e});`);
    blocks.push(`  way["leisure"="golf_course"](${s},${w},${n},${e});`);
  }
  if (ski) {
    blocks.push(`  way["piste:type"](${s},${w},${n},${e});`);
    blocks.push(`  way["aerialway"](${s},${w},${n},${e});`);
  }
  if (buildings) {
    blocks.push(`  way["building"](${s},${w},${n},${e});`);
  }
  return `[out:json][timeout:25];\n(\n${blocks.join('\n')}\n);\nout geom;`;
}

export async function fetchOverpass(
  bbox: [number, number, number, number],
  opts: { cacheDir?: string; fetch?: OverpassFetcher; allowNetwork?: boolean; query?: string; features?: string[] } = {},
): Promise<unknown> {
  const query = opts.query ?? overpassQueryForBbox(bbox, opts.features);
  const run = opts.fetch ?? fetcherOverride ?? (opts.allowNetwork ? defaultOverpassFetch : null);
  if (!run) {
    if (opts.cacheDir) {
      const hit = readOverpassCache(opts.cacheDir, query);
      if (hit) return hit;
    }
    throw new Error('Overpass unavailable offline (use --map-cache after a networked fetch)');
  }
  return cachedMapJson(opts.cacheDir, 'overpass', query, () => run(query));
}
