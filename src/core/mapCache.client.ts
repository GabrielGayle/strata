/** Browser build: no on-disk map cache (CLI uses `mapCache.ts`). */
type MapCacheKind = 'terrarium' | 'cog' | 'wms' | 'bytes' | 'nominatim' | 'overpass';

export async function cachedTileFetch(_dir: string | undefined, url: string, inner: (url: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  return inner(url);
}

export async function cachedMapBytes(
  dir: string | undefined,
  _kind: MapCacheKind,
  url: string,
  inner: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (!dir) return inner(url);
  return inner(url);
}

export async function cachedMapJson<T>(_dir: string | undefined, _kind: MapCacheKind, _key: string, inner: () => Promise<T>): Promise<T> {
  return inner();
}

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
