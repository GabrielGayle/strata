import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAYERS } from '../src/core/dxf';
import { partDxf } from '../src/core/exporters';
import { cleanMapSpec, defaultMapSpec } from '../src/core/mapSpec';
import { osmToEngraveArt, serializeMapEngraveArt } from '../src/core/mapOsmEngrave';
import { MAP_ENGRAVE_PRESETS, resolveEngravePreset } from '../src/core/mapEngravePresets';
import { mapEngravePathsForPart } from '../src/core/mapEngravePlate';
import { STRATA_OVERPASS_UA } from '../src/core/mapOverpass';
import { buildMapEngraveArt } from '../src/core/mapEngraveBuild';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { NEASDEN_BBOX } from './map-fixtures';
import type { Part } from '../src/core/slicer';

const overpassFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-neasden.json', import.meta.url)), 'utf8'),
);

describe('map OSM engrave (T13)', () => {
  it('parses fixture ways into road and water linework', () => {
    const art = osmToEngraveArt(overpassFixture, NEASDEN_BBOX, 128, 96, ['roads', 'water']);
    expect(art.lines.some((l) => l.kind === 'road')).toBe(true);
    expect(art.lines.some((l) => l.kind === 'water')).toBe(true);
    expect(art.osmAttribution).toMatch(/OpenStreetMap/);
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

  it('attaches engrave art when Overpass fixture is supplied', async () => {
    const { depth } = mapGridToDepth(syntheticConeGrid(32, 24, 18));
    const spec = defaultMapSpec({
      bbox: NEASDEN_BBOX,
      source: 'terrarium',
      engrave: { enabled: true, features: ['roads', 'water'] },
    });
    const art = await buildMapEngraveArt(spec, depth, { overpass: async () => overpassFixture });
    expect(art?.lines.length).toBeGreaterThan(0);
  });

  it('round-trips engrave art on MapSpec', () => {
    const art = osmToEngraveArt(overpassFixture, NEASDEN_BBOX, 64, 64, ['roads']);
    const raw = defaultMapSpec({ bbox: NEASDEN_BBOX, engraveArt: serializeMapEngraveArt(art) });
    const spec = cleanMapSpec(raw);
    expect(spec?.engraveArt?.lines.length).toBeGreaterThan(0);
  });
});
