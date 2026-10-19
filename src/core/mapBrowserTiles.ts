import { setMapTileFetcher, type TileFetcher } from './mapTerrarium';

/** E2E / offline dev: serve terrarium tiles from Vite `/map-fixtures/`. */
export function fixtureTerrariumFetcher(): TileFetcher {
  return async (url: string, signal?: AbortSignal) => {
    const m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!m) throw new Error(`no fixture for ${url}`);
    const [, z, x, y] = m;
    const paths = [`/map-fixtures/neasden/${z}/${x}_${y}.png`, `/map-fixtures/decode/${z}_${x}_${y}.png`];
    for (const p of paths) {
      const res = await fetch(p, { signal });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    }
    throw new Error(`fixture tile missing for z=${z} x=${x} y=${y}`);
  };
}

let browserFetcher: TileFetcher | null = null;

export function getBrowserMapTileFetcher(): TileFetcher {
  if (browserFetcher) return browserFetcher;
  if (import.meta.env.VITE_E2E_MAP_FIXTURES === '1') {
    browserFetcher = fixtureTerrariumFetcher();
    setMapTileFetcher(browserFetcher);
    return browserFetcher;
  }
  return async (url, signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Terrarium tile fetch failed: ${url} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

export function installE2eMapTileFixtures() {
  if (import.meta.env.VITE_E2E_MAP_FIXTURES === '1') getBrowserMapTileFetcher();
}
