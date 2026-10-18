/**
 * Browser build of `mapCache.ts` (swapped in by vite.config.ts): the same
 * kinds and keys as the CLI's on-disk cache, stored in IndexedDB. `dir` is
 * ignored; the browser always caches.
 */
import { browserMapCacheGet, browserMapCacheSet } from './mapCacheBrowser';

type MapCacheKind = 'terrarium' | 'cog' | 'wms' | 'bytes' | 'nominatim' | 'overpass';

/** Elevation rasters do not change; OSM answers are refreshed after a month. */
const MAX_AGE_MS: Record<MapCacheKind, number> = {
  terrarium: Infinity,
  cog: Infinity,
  wms: Infinity,
  bytes: Infinity,
  nominatim: 30 * 24 * 3600 * 1000,
  overpass: 30 * 24 * 3600 * 1000,
};

export async function cachedTileFetch(dir: string | undefined, url: string, inner: (url: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  return cachedMapBytes(dir, 'terrarium', url, inner);
}

export async function cachedMapBytes(
  _dir: string | undefined,
  kind: MapCacheKind,
  url: string,
  inner: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const hit = await browserMapCacheGet(kind, url, MAX_AGE_MS[kind]);
  if (hit instanceof Uint8Array) return hit;
  const data = await inner(url);
  void browserMapCacheSet(kind, url, data);
  return data;
}

export async function cachedMapJson<T>(_dir: string | undefined, kind: MapCacheKind, key: string, inner: () => Promise<T>): Promise<T> {
  const hit = await browserMapCacheGet(kind, key, MAX_AGE_MS[kind]);
  if (typeof hit === 'string') {
    try {
      return JSON.parse(hit) as T;
    } catch {
      /* corrupt entry: refetch */
    }
  }
  const data = await inner();
  if (cacheable(kind, data)) void browserMapCacheSet(kind, key, JSON.stringify(data));
  return data;
}

/** Overpass reports runtime errors (timeouts, memory) as a 200 with a `remark`; never keep those. */
function cacheable(kind: MapCacheKind, data: unknown): boolean {
  if (data == null) return false;
  if (kind === 'overpass' && typeof data === 'object' && 'remark' in data) return false;
  return true;
}

/** Offline Overpass reads (no fetcher) go through `cachedMapJson` in the browser; there is no sync store. */
export function readMapCacheJson(): null {
  return null;
}

export function writeMapCacheJson(): void {
  /* no-op in browser */
}

export function readOverpassCache(): null {
  return null;
}

export function writeOverpassCache(): void {
  /* no-op */
}
