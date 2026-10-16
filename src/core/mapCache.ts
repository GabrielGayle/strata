// CLI / headless cache for raw terrarium PNG tiles (not embedded in project JSON).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function mapCacheRoot(dir?: string): string {
  const root = dir?.trim() || join(process.env.HOME || '/tmp', '.cache', 'strata', 'map');
  mkdirSync(root, { recursive: true });
  return root;
}

function keyOf(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 40);
}

export function readMapCache(dir: string, url: string): Uint8Array | null {
  return readMapCacheBytes(dir, 'terrarium', url);
}

export function writeMapCache(dir: string, url: string, data: Uint8Array): void {
  writeMapCacheBytes(dir, 'terrarium', url, data);
}

export async function cachedTileFetch(dir: string | undefined, url: string, inner: (url: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  return cachedMapBytes(dir, 'terrarium', url, inner);
}

export type MapCacheKind = 'terrarium' | 'cog' | 'wms' | 'bytes';

function cacheFileName(kind: MapCacheKind, url: string): string {
  const ext = kind === 'terrarium' ? 'terrarium.png' : kind === 'cog' ? 'cog.bin' : kind === 'wms' ? 'wms.bin' : 'bytes';
  return `${keyOf(url)}.${ext}`;
}

export function readMapCacheBytes(dir: string, kind: MapCacheKind, url: string): Uint8Array | null {
  try {
    return readFileSync(join(dir, cacheFileName(kind, url)));
  } catch {
    return null;
  }
}

export function writeMapCacheBytes(dir: string, kind: MapCacheKind, url: string, data: Uint8Array): void {
  const root = mapCacheRoot(dir);
  writeFileSync(join(root, cacheFileName(kind, url)), data);
}

/** Unified on-disk cache for map adapters (ticket T7 extends kinds; terrarium keeps compat). */
export async function cachedMapBytes(
  dir: string | undefined,
  kind: MapCacheKind,
  url: string,
  inner: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (!dir) return inner(url);
  const root = mapCacheRoot(dir);
  const hit = readMapCacheBytes(root, kind, url);
  if (hit) return hit;
  const data = await inner(url);
  writeMapCacheBytes(root, kind, url, data);
  return data;
}
