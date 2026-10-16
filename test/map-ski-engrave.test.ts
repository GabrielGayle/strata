import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overpassQueryForBbox } from '../src/core/mapOverpass';
import { osmToEngraveArt } from '../src/core/mapOsmEngrave';
import { resolveEngravePreset } from '../src/core/mapEngravePresets';
import { NEASDEN_BBOX } from './map-fixtures';

const skiFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-ski.json', import.meta.url)), 'utf8'),
);

describe('map ski engrave (T22)', () => {
  it('extends Overpass query for piste/aerialway features', () => {
    const q = overpassQueryForBbox(NEASDEN_BBOX, ['ski', 'piste']);
    expect(q).toMatch(/piste:type/);
    expect(q).toMatch(/aerialway/);
  });

  it('parses piste linework from fixture', () => {
    const art = osmToEngraveArt(skiFixture, NEASDEN_BBOX, 96, 72, ['piste']);
    expect(art.lines.some((l) => l.kind === 'piste')).toBe(true);
  });

  it('uses the ski typographic preset', () => {
    expect(resolveEngravePreset('ski').label).toMatch(/Ski/i);
  });
});
