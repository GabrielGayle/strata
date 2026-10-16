import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeTerrariumMetres,
  decodeTerrariumPng,
  fetchTerrariumGrid,
  terrariumUrl,
} from '../src/core/mapTerrarium';
import { gridElevationRange, gridPercentileRange } from '../src/core/mapTerrarium';
import { NEASDEN_BBOX } from './map-fixtures';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'map');

function fixtureFetcher(url: string): Promise<Uint8Array> {
  const m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) throw new Error(`no fixture for ${url}`);
  const [, z, x, y] = m;
  const decodePath = join(fixtureRoot, 'decode', `${z}_${x}_${y}.png`);
  const neasdenPath = join(fixtureRoot, 'neasden', z, `${x}_${y}.png`);
  try {
    return Promise.resolve(readFileSync(decodePath));
  } catch {
    return Promise.resolve(readFileSync(neasdenPath));
  }
}

describe('terrarium adapter', () => {
  it('decodes a fixture tile pixel to known metres (±0.1)', () => {
    const buf = readFileSync(join(fixtureRoot, 'decode', '15_16384_10889.png'));
    const { w, data } = decodeTerrariumPng(buf);
    const m = data[128 * w + 128];
    expect(m).toBeCloseTo(11.19140625, 1);
    expect(decodeTerrariumMetres(128, 11, 49)).toBeCloseTo(11.19140625, 1);
  });

  it('mosaics and crops the Neasden fixture to 28–68 m relief', async () => {
    const grid = await fetchTerrariumGrid({ bbox: NEASDEN_BBOX }, { fetch: fixtureFetcher, zoom: 13 });
    const { min } = gridElevationRange(grid);
    expect(min).toBeGreaterThanOrEqual(28);
    const band = gridPercentileRange(grid, 2, 96);
    expect(band.min).toBeGreaterThanOrEqual(28);
    expect(band.max).toBeLessThanOrEqual(68.7);
    expect(grid.w).toBeGreaterThan(8);
    expect(grid.h).toBeGreaterThan(8);
    expect(grid.crs).toBe('EPSG:3857');
  });

  it('maps tile URLs for the fetcher hook', () => {
    expect(terrariumUrl(11, 1022, 680)).toContain('1022/680.png');
  });
});
