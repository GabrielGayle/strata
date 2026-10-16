import { cachedMapJson } from './mapCache';

/** Nominatim search for the map UI (ticket T8). Throttled to 1 req/s; always send a proper User-Agent. */
export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
export const STRATA_NOMINATIM_UA =
  'StrataMap/0.1 (https://github.com/GabrielGayle/strata; map window geocoding)';

export interface NominatimPlace {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
}

export type NominatimFetcher = (url: string) => Promise<NominatimPlace[]>;

let fetcherOverride: NominatimFetcher | null = null;
let lastRequestAt = 0;

export function setNominatimFetcher(fetcher: NominatimFetcher | null): void {
  fetcherOverride = fetcher;
}

export function nominatimBbox(hit: NominatimPlace): [number, number, number, number] {
  const [south, north, west, east] = hit.boundingbox.map(Number);
  return [west, south, east, north];
}

async function defaultNominatimFetch(url: string): Promise<NominatimPlace[]> {
  const res = await fetch(url, { headers: { 'User-Agent': STRATA_NOMINATIM_UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim failed (${res.status})`);
  const data = (await res.json()) as NominatimPlace[];
  return Array.isArray(data) ? data : [];
}

/** Search with ≥1 s between calls (Nominatim usage policy). */
export async function searchNominatim(
  query: string,
  opts: { fetch?: NominatimFetcher; cacheDir?: string } = {},
): Promise<NominatimPlace[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, format: 'json', limit: '5', addressdetails: '0' });
  const url = `${NOMINATIM_SEARCH_URL}?${params}`;
  return cachedMapJson(opts.cacheDir, 'nominatim', url, async () => {
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - lastRequestAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const run = opts.fetch ?? fetcherOverride ?? defaultNominatimFetch;
    return run(url);
  });
}
