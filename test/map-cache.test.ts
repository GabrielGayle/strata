import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedMapBytes } from '../src/core/mapCache';
import { browserMapCacheGet, browserMapCacheSet, clearInMemoryMapCache, useInMemoryMapCache } from '../src/core/mapCacheBrowser';
import { setNominatimFetcher } from '../src/core/mapNominatim';
import { searchNominatimCached } from '../src/core/mapNominatimCli';

describe('map cache (T7)', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
    setNominatimFetcher(null);
    clearInMemoryMapCache();
  });

  it('cachedMapBytes hits disk on second fetch without calling inner', async () => {
    dir = mkdtempSync(join(tmpdir(), 'strata-map-cache-'));
    const inner = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const url = 'https://example.com/tile.png';
    await cachedMapBytes(dir, 'terrarium', url, inner);
    await cachedMapBytes(dir, 'terrarium', url, inner);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('cachedMapJson stores Nominatim responses under --map-cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'strata-map-cache-'));
    let calls = 0;
    setNominatimFetcher(async () => {
      calls += 1;
      return [{ display_name: 'Test', lat: '51.5', lon: '-0.2', boundingbox: ['51', '52', '-0.3', '-0.1'] }];
    });
    await searchNominatimCached('neasden', dir);
    await searchNominatimCached('neasden', dir);
    expect(calls).toBe(1);
  });

  it('browser in-memory cache round-trips', async () => {
    useInMemoryMapCache();
    await browserMapCacheSet('nominatim', 'k', '{"ok":true}');
    expect(await browserMapCacheGet('nominatim', 'k')).toBe('{"ok":true}');
  });
});
