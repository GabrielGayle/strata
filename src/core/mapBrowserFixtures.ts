import type { Float32Grid } from './mapGrid';
import type { MapSource } from './mapSpec';
import type { EaGridLoader } from './mapEaLidar';
import type { RegionalGridLoader } from './mapRegionalLidar';
import { cropRegionalGridToBbox } from './mapRegionalLidar';
import type { OverpassFetcher } from './mapOverpass';

async function fetchJsonGrid(path: string): Promise<Float32Grid | null> {
  const res = await fetch(path);
  if (!res.ok) return null;
  const raw = (await res.json()) as {
    w: number;
    h: number;
    data: number[];
    crs: string;
    transform: Float32Grid['transform'];
  };
  return { ...raw, data: new Float32Array(raw.data) };
}

export function browserEaGridLoader(): EaGridLoader {
  return async (_source, spec) => {
    const g = await fetchJsonGrid('/map-fixtures/regional/neasden-ea-dtm.json');
    return g ? cropRegionalGridToBbox(g, spec.bbox) : null;
  };
}

export function browserRegionalGridLoader(): RegionalGridLoader {
  const files: Partial<Record<MapSource, string>> = {
    'scot-dtm': '/map-fixtures/regional/kingsbarns-scot-dtm.json',
    'ni-dtm': '/map-fixtures/regional/royal-county-down-ni-dtm.json',
  };
  return async (source, spec) => {
    const path = files[source];
    if (!path) return null;
    const g = await fetchJsonGrid(path);
    return g ? cropRegionalGridToBbox(g, spec.bbox) : null;
  };
}

export function browserOverpassFetcher(): OverpassFetcher {
  return async () => {
    const res = await fetch('/map-fixtures/overpass-neasden.json');
    if (!res.ok) throw new Error(`Overpass fixture missing (${res.status})`);
    return res.json();
  };
}
