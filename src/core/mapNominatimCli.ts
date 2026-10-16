/** Node/CLI Nominatim search with on-disk cache (ticket T7). Not imported by the browser UI bundle. */
import { cachedMapJson } from './mapCache';
import { NOMINATIM_SEARCH_URL, searchNominatim, type NominatimFetcher, type NominatimPlace } from './mapNominatim';

export async function searchNominatimCached(
  query: string,
  cacheDir: string,
  opts: { fetch?: NominatimFetcher } = {},
): Promise<NominatimPlace[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, format: 'json', limit: '5', addressdetails: '0' });
  const url = `${NOMINATIM_SEARCH_URL}?${params}`;
  return cachedMapJson(cacheDir, 'nominatim', url, () => searchNominatim(q, opts));
}
