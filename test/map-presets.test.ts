import { describe, expect, it } from 'vitest';
import { mapPresetIdList, mapPresetSpec, parseMapPresetId } from '../src/core/mapPresets';
import { mapBuildKey, mapTerrainIsCurrent } from '../src/core/mapBuildKey';
import { parseCliArgs } from '../src/cli';

describe('map presets registry', () => {
  it('lists known preset ids', () => {
    expect(mapPresetIdList()).toContain('neasden');
    expect(() => parseMapPresetId('nope')).toThrow(/valid:/);
  });

  it('neasden preset has bbox and engrave', () => {
    const spec = mapPresetSpec('neasden');
    expect(spec.bbox[0]).toBeLessThan(spec.bbox[2]);
    expect(spec.engrave.enabled).toBe(true);
    expect(spec.buildKey).toBeUndefined();
    const key = mapBuildKey(spec);
    expect(mapTerrainIsCurrent({ ...spec, buildKey: key }, { settings: {} })).toBe(true);
  });
});

describe('CLI --map-preset', () => {
  it('accepts map preset without bbox', () => {
    const args = parseCliArgs(['project.json', '--out', 'out', '--map-preset', 'neasden']);
    expect(args.mapPreset).toBe('neasden');
  });

  it('rejects unknown map preset', () => {
    expect(() => parseCliArgs(['project.json', '--out', 'out', '--map-preset', 'unknown'])).toThrow();
  });
});
