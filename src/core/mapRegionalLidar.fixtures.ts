import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Float32Grid } from './mapGrid';
import type { MapSource } from './mapSpec';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../test/fixtures/map/regional/${name}.json`, import.meta.url));
}

export function loadBuiltinRegionalFixture(source: MapSource): Float32Grid | null {
  const file = source === 'scot-dtm' ? 'kingsbarns-scot-dtm' : source === 'ni-dtm' ? 'royal-county-down-ni-dtm' : null;
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(fixturePath(file), 'utf8')) as {
      w: number;
      h: number;
      data: number[];
      crs: string;
      transform: Float32Grid['transform'];
    };
    return { ...raw, data: new Float32Array(raw.data) };
  } catch {
    return null;
  }
}
