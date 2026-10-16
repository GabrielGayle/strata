import { describe, expect, it } from 'vitest';
import { applyProjectPatch } from '../src/core/design/patch';
import { parseDesign } from '../src/core/design/parse';
import {
  WELSH_HARP_SAMPLE_POINT,
  WELSH_HARP_WATER_BBOX,
  bboxContainsPoint,
  unionMapBbox,
  NEASDEN_MAP_BBOX,
} from '../src/core/mapPresets';
import { newProject } from '../src/core/project';

describe('map design parser (T18)', () => {
  const ctx = () => ({ project: newProject() });

  it('parses Neasden map preset onto the top face', () => {
    const r = parseDesign('Neasden map with 12 plates', ctx());
    expect(r.patch.map?.title).toBe('Neasden');
    expect(r.patch.map?.bbox).toEqual(NEASDEN_MAP_BBOX);
    const project = applyProjectPatch(newProject(), r.patch);
    expect(project.images.top?.map?.bbox).toEqual(NEASDEN_MAP_BBOX);
  });

  it('expands bbox to include Welsh Harp when asked', () => {
    const text = 'Neasden map, include Welsh Harp';
    const r = parseDesign(text, ctx());
    const bbox = r.patch.map?.bbox;
    expect(bbox).toBeDefined();
    expect(bboxContainsPoint(bbox!, WELSH_HARP_SAMPLE_POINT[0], WELSH_HARP_SAMPLE_POINT[1])).toBe(true);
    const expected = unionMapBbox(NEASDEN_MAP_BBOX, WELSH_HARP_WATER_BBOX);
    expect(bbox).toEqual(expected);
  });
});
