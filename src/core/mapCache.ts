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
  try {
    return readFileSync(join(dir, `${keyOf(url)}.terrarium.png`));
  } catch {
    return null;
  }
}

export function writeMapCache(dir: string, url: string, data: Uint8Array): void {
  const root = mapCacheRoot(dir);
  writeFileSync(join(root, `${keyOf(url)}.terrarium.png`), data);
}

export async function cachedTileFetch(dir: string | undefined, url: string, inner: (url: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  if (!dir) return inner(url);
  const root = mapCacheRoot(dir);
  const hit = readMapCache(root, url);
  if (hit) return hit;
  const data = await inner(url);
  writeMapCache(root, url, data);
  return data;
}
