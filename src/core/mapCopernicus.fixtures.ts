import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Float32Grid } from './mapGrid';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../test/fixtures/map/${name}.json`, import.meta.url));
}

export function loadBuiltinCop30Fixture(name = 'cop30-neasden'): Float32Grid | null {
  try {
    const raw = JSON.parse(readFileSync(fixturePath(name), 'utf8')) as {
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
