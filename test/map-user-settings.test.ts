import { describe, expect, it } from 'vitest';
import { defaultMapSpec } from '../src/core/mapSpec';
import { keepUserMapSettings, mapPresetSpec, mapPresetSpecKeepingUser } from '../src/core/mapPresets';
import { projectWithTopMapSpec } from '../src/core/mapTopAsset';
import { mergeDepthAfterRebuild, markDepthSettingOverrides } from '../src/core/depthOverrides';
import { newProject } from '../src/core/project';
import type { DepthData } from '../src/core/depth';

const BBOX: [number, number, number, number] = [-0.28, 51.543, -0.233, 51.575];

function fakeDepth(near: number, far: number, overrides?: DepthData['settingsOverrides']): DepthData {
  return {
    w: 4,
    h: 4,
    minM: 1,
    maxM: 80,
    nearM: 2,
    farM: 70,
    data: 'AAAA',
    settings: {
      near,
      far,
      spacing: 'perspective',
      curve: 1,
      flatten: 0,
      matte: true,
      resolution: 64,
      invert: false,
    },
    settingsOverrides: overrides,
  };
}

describe('keep user map settings on preset re-click and source change', () => {
  it('Maps/Neasden re-apply keeps user exaggeration, frame, and gift size', () => {
    const prev = defaultMapSpec({
      bbox: BBOX,
      exaggeration: 21,
      sunkenFrame: { enabled: true, wallMm: 18 },
      giftSizeId: 'a6',
    });
    const next = mapPresetSpecKeepingUser('neasden', prev);
    expect(next.exaggeration).toBe(21);
    expect(next.sunkenFrame).toEqual({ enabled: true, wallMm: 18 });
    expect(next.giftSizeId).toBe('a6');
    expect(next.bbox).toEqual(mapPresetSpec('neasden').bbox);
    expect(next.title).toBe('Neasden');
  });

  it('does not invent a user exaggeration when the previous spec was auto', () => {
    const prev = defaultMapSpec({ bbox: BBOX, exaggeration: 'auto' });
    expect(mapPresetSpecKeepingUser('neasden', prev).exaggeration).toBe('auto');
    expect(keepUserMapSettings(undefined, mapPresetSpec('neasden')).exaggeration).toBe('auto');
  });

  it('source change via patch keeps user exaggeration / frame / size', () => {
    const prev = defaultMapSpec({
      bbox: BBOX,
      exaggeration: 21,
      source: 'ea-dtm',
      sunkenFrame: { enabled: true, wallMm: 12 },
      giftSizeId: 'postcard',
    });
    const sourced = defaultMapSpec({ ...prev, source: 'terrarium' });
    expect(sourced.exaggeration).toBe(21);
    expect(sourced.sunkenFrame?.enabled).toBe(true);
    expect(sourced.giftSizeId).toBe('postcard');
    expect(sourced.source).toBe('terrarium');
  });

  it('setTopMap / projectWithTopMapSpec does not clobber master size', () => {
    const p = newProject();
    p.params = { ...p.params, baseLength: '999', baseWidth: '111' };
    const next = projectWithTopMapSpec(p, mapPresetSpecKeepingUser('neasden', p.images.top?.map));
    expect(next.params.baseLength).toBe('999');
    expect(next.params.baseWidth).toBe('111');
  });

  it('rebuild keeps user-set near/far when overrides are marked', () => {
    const prev = fakeDepth(5, 40, markDepthSettingOverrides(undefined, { near: 5, far: 40 }));
    const rebuilt = fakeDepth(2, 70);
    const merged = mergeDepthAfterRebuild(prev, rebuilt);
    expect(merged.settings.near).toBe(5);
    expect(merged.settings.far).toBe(40);
    expect(merged.settingsOverrides?.near).toBe(true);
    expect(merged.nearM).toBe(2);
  });

  it('rebuild without overrides uses the new auto near/far', () => {
    const prev = fakeDepth(5, 40);
    const rebuilt = fakeDepth(2, 70);
    const merged = mergeDepthAfterRebuild(prev, rebuilt);
    expect(merged.settings.near).toBe(2);
    expect(merged.settings.far).toBe(70);
  });
});
