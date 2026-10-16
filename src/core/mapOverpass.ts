// Overpass API client with polite User-Agent and on-disk cache (offline tests use fixtures).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const STRATA_OVERPASS_UA = 'StrataMap/0.1 (+https://github.com/GabrielGayle/strata; map engraving)';

export type OverpassFetcher = (query: string) => Promise<unknown>;

let fetcherOverride: OverpassFetcher | null = null;

export function setOverpassFetcher(fetch: OverpassFetcher | null): void {
  fetcherOverride = fetch;
}

function cacheKey(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 32);
}

export function readOverpassCache(cacheDir: string, query: string): unknown | null {
  try {
    const raw = readFileSync(join(cacheDir, `${cacheKey(query)}.overpass.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeOverpassCache(cacheDir: string, query: string, data: unknown): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${cacheKey(query)}.overpass.json`), JSON.stringify(data));
}

export async function defaultOverpassFetch(query: string): Promise<unknown> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': STRATA_OVERPASS_UA },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass failed (${res.status})`);
  return res.json();
}

export function overpassQueryForBbox(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `[out:json][timeout:25];
(
  way["highway"](${s},${w},${n},${e});
  way["natural"="water"](${s},${w},${n},${e});
  way["waterway"](${s},${w},${n},${e});
  way["railway"](${s},${w},${n},${e});
);
out geom;`;
}

export async function fetchOverpass(
  bbox: [number, number, number, number],
  opts: { cacheDir?: string; fetch?: OverpassFetcher; allowNetwork?: boolean; query?: string } = {},
): Promise<unknown> {
  const query = opts.query ?? overpassQueryForBbox(bbox);
  if (opts.cacheDir) {
    const hit = readOverpassCache(opts.cacheDir, query);
    if (hit) return hit;
  }
  const run = opts.fetch ?? fetcherOverride ?? (opts.allowNetwork ? defaultOverpassFetch : null);
  if (!run) throw new Error('Overpass unavailable offline (use --map-cache after a networked fetch)');
  const data = await run(query);
  if (opts.cacheDir) writeOverpassCache(opts.cacheDir, query, data);
  return data;
}
