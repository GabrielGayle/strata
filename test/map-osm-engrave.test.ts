import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAYERS } from '../src/core/dxf';
import { partDxf } from '../src/core/exporters';
import { cleanMapSpec, defaultMapSpec } from '../src/core/mapSpec';
import { osmToEngraveArt, serializeMapEngraveArt } from '../src/core/mapOsmEngrave';
import { MAP_ENGRAVE_PRESETS, resolveEngravePreset } from '../src/core/mapEngravePresets';
import { mapEngravePathsForPart } from '../src/core/mapEngravePlate';
import { setOverpassFetcher, STRATA_OVERPASS_UA, type OverpassFetcher } from '../src/core/mapOverpass';
import { mapNoticesMatching } from '../src/core/mapNotices';
import { buildMapBundle } from '../src/core/mapPipeline';
import { resetOverpassInflight, setOverpassTestDelays } from '../src/core/mapOverpassFetch';
import { setEaGridLoader } from '../src/core/mapEaLidar';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import type { Float32Grid } from '../src/core/mapGrid';
import { NEASDEN_FAST_BBOX, NEASDEN_BBOX } from './map-fixtures';
import type { Part } from '../src/core/slicer';

const overpassFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-neasden.json', import.meta.url)), 'utf8'),
);

beforeEach(() => {
  setMapTileFetcher(null);
  setOverpassFetcher(null);
  setEaGridLoader(null);
  resetOverpassInflight();
  setOverpassTestDelays({ timeoutMs: 1, browserRetryMs: 0 });
});

afterEach(() => {
  setMapTileFetcher(null);
  setOverpassFetcher(null);
  setEaGridLoader(null);
  resetOverpassInflight();
  setOverpassTestDelays(null);
});

/** Tiny in-memory DTM so these tests never mosaic tiles or decode a GeoTIFF. */
function tinyEaGrid(): Float32Grid {
  const data = new Float32Array(64);
  for (let i = 0; i < data.length; i++) data[i] = 40 + (i % 8);
  return {
    w: 8,
    h: 8,
    data,
    crs: 'EPSG:27700',
    transform: { originX: 519000, originY: 188000, pixelW: 500, pixelH: -500 },
  };
}

function noNetworkTiles(): Promise<Uint8Array> {
  return Promise.reject(new Error('network disabled in map-osm-engrave tests'));
}

/** Equal budget + coarse res so two sequential builds stay well under the 5 s vitest cap. */
const FAST_SPEC = {
  bbox: NEASDEN_FAST_BBOX,
  source: 'ea-dtm' as const,
  water: 'raw' as const,
  resM: 32,
  layerBudget: 'equal' as const,
  engrave: { enabled: true, features: ['roads', 'water'] as string[] },
};

const FAST_STACK = { plateCount: 4, thicknessMm: 3, masterWidthMm: 120, layerBudget: 'equal' as const };

function bundleOpts(overpass: OverpassFetcher) {
  return {
    eaLoader: async () => tinyEaGrid(),
    overpass,
    allowOverpassNetwork: false as const,
    fetch: noNetworkTiles,
    stack: FAST_STACK,
  };
}

const okOverpass: OverpassFetcher = async () => overpassFixture;
const failOverpass: OverpassFetcher = async () => {
  throw new Error('Overpass proxy failed (502)');
};

describe('map OSM engrave (T13)', () => {
  it('parses fixture ways into road and water linework', () => {
    const art = osmToEngraveArt(overpassFixture, NEASDEN_BBOX, 128, 96, ['roads', 'water']);
    expect(art.lines.some((l) => l.kind === 'road')).toBe(true);
    expect(art.lines.some((l) => l.kind === 'water')).toBe(true);
    expect(art.osmAttribution).toMatch(/OpenStreetMap/);
    expect(art.texts).toEqual([]);
  });

  it('places named way labels when the labels feature is on', () => {
    const named = {
      ...overpassFixture,
      elements: [
        ...overpassFixture.elements,
        {
          type: 'way',
          id: 9,
          tags: { highway: 'residential', name: 'Neasden Lane' },
          geometry: [
            { lat: 51.56, lon: -0.26 },
            { lat: 51.562, lon: -0.255 },
          ],
        },
      ],
    };
    const off = osmToEngraveArt(named, NEASDEN_BBOX, 128, 96, ['roads', 'water']);
    expect(off.texts).toEqual([]);
    const on = osmToEngraveArt(named, NEASDEN_BBOX, 128, 96, ['roads', 'water', 'labels']);
    expect(on.texts.some((t) => t.text === 'Neasden Lane')).toBe(true);
  });

  it('exposes grouped typographic presets', () => {
    expect(Object.keys(MAP_ENGRAVE_PRESETS).sort()).toEqual(['alpine', 'city', 'golf', 'nautical', 'ski', 'survey']);
    expect(resolveEngravePreset('nautical').titleHeightMm).toBeGreaterThan(0);
  });

  it('writes ENGRAVE layer paths clipped inside a synthetic part', () => {
    const art = osmToEngraveArt(overpassFixture, NEASDEN_BBOX, 100, 80, ['roads', 'water', 'title']);
    const part: Part = {
      id: 'P12',
      plateKey: 'P12',
      family: 'P',
      index: 11,
      piece: 0,
      plane: { origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 1, 0] },
      thickness: 3,
      shape: [{ outer: [[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]], holes: [] }],
      etch: [],
      labelPaths: [],
      labelAt: null,
      area: 8000,
      perimeter: 360,
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 80 },
      anchored: true,
      kind: 'plate',
    };
    const paths = mapEngravePathsForPart(part, art, { faceW: 100, faceH: 80, title: 'Neasden' });
    expect(paths.length).toBeGreaterThan(0);
    const dxf = partDxf(part, { kerf: 0.2, arcTolerance: 0.05, dxfMode: 'polyline' } as never, paths);
    expect(dxf).toContain(`8\n${LAYERS.ENGRAVE.name}`);
    expect(dxf).not.toContain(`8\n${LAYERS.ENGRAVE.name}\n8\n${LAYERS.ENGRAVE.name}`);
  });

  it('uses a polite Overpass User-Agent constant', () => {
    expect(STRATA_OVERPASS_UA).toMatch(/StrataMap/);
  });

  it('buildMapBundle attaches engrave art when Overpass fixture is supplied', async () => {
    const bundle = await buildMapBundle(defaultMapSpec(FAST_SPEC), bundleOpts(okOverpass));
    expect(bundle.asset.map?.engraveArt?.lines.length).toBeGreaterThan(0);
  });

  it('does not keep stale OSM engrave art after a failed pass', async () => {
    const ok = await buildMapBundle(defaultMapSpec(FAST_SPEC), bundleOpts(okOverpass));
    expect(ok.asset.map?.engraveArt?.lines.length).toBeGreaterThan(0);
    const failed = await buildMapBundle(
      defaultMapSpec({
        ...ok.asset.map,
        ...FAST_SPEC,
      }),
      bundleOpts(failOverpass),
    );
    expect(failed.asset.map?.engraveArt).toBeUndefined();
    expect(mapNoticesMatching(failed.asset.map?.sourceWarnings, /OSM engrave skipped/)).toBe(true);
  });

  it('clears OSM engrave skipped when a later pass succeeds', async () => {
    const failed = await buildMapBundle(defaultMapSpec(FAST_SPEC), bundleOpts(failOverpass));
    expect(mapNoticesMatching(failed.asset.map?.sourceWarnings, /OSM engrave skipped/)).toBe(true);
    const ok = await buildMapBundle(
      defaultMapSpec({
        ...failed.asset.map,
        ...FAST_SPEC,
      }),
      bundleOpts(okOverpass),
    );
    expect(ok.asset.map?.engraveArt?.lines.length).toBeGreaterThan(0);
    expect(mapNoticesMatching(ok.asset.map?.sourceWarnings, /OSM engrave skipped/)).toBe(false);
  });

  it('round-trips engrave art on MapSpec', () => {
    const art = osmToEngraveArt(overpassFixture, NEASDEN_BBOX, 64, 64, ['roads']);
    const raw = defaultMapSpec({ bbox: NEASDEN_BBOX, engraveArt: serializeMapEngraveArt(art) });
    const spec = cleanMapSpec(raw);
    expect(spec?.engraveArt?.lines.length).toBeGreaterThan(0);
  });
});
