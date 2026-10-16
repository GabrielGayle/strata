import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overpassQueryForBbox } from '../src/core/mapOverpass';
import { osmToEngraveArt } from '../src/core/mapOsmEngrave';
import { resolveEngravePreset } from '../src/core/mapEngravePresets';
import { NEASDEN_BBOX } from './map-fixtures';

const golfFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-golf.json', import.meta.url)), 'utf8'),
);

describe('map golf engrave (T21)', () => {
  it('extends Overpass query when golf features are requested', () => {
    const q = overpassQueryForBbox(NEASDEN_BBOX, ['roads', 'golf']);
    expect(q).toMatch(/way\["golf"\]/);
    expect(q).not.toMatch(/piste:type/);
  });

  it('parses golf fairway linework from fixture', () => {
    const art = osmToEngraveArt(golfFixture, NEASDEN_BBOX, 96, 72, ['golf']);
    expect(art.lines.some((l) => l.kind === 'golf')).toBe(true);
  });

  it('uses the golf typographic preset', () => {
    const p = resolveEngravePreset('golf');
    expect(p.roadWidthMm).toBeLessThan(resolveEngravePreset('survey').roadWidthMm);
  });
});
