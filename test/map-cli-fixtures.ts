import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TileFetcher } from '../src/core/mapTerrarium';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'map');

export const fixtureTileFetcher: TileFetcher = (url) => {
  const m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) return Promise.reject(new Error(`no fixture for ${url}`));
  const [, z, x, y] = m;
  const decodePath = join(fixtureRoot, 'decode', `${z}_${x}_${y}.png`);
  const neasdenPath = join(fixtureRoot, 'neasden', z, `${x}_${y}.png`);
  try {
    return Promise.resolve(readFileSync(decodePath));
  } catch {
    return Promise.resolve(readFileSync(neasdenPath));
  }
};
