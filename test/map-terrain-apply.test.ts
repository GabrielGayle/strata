import { describe, expect, it } from 'vitest';
import { mapBuildKey } from '../src/core/mapBuildKey';
import { defaultMapSpec } from '../src/core/mapSpec';
import { applyBuiltMapAsset, projectWithTopMapSpec } from '../src/core/mapTopAsset';
import type { ImageAsset } from '../src/core/project';
import { newProject } from '../src/core/project';

const bbox: [number, number, number, number] = [-0.26, 51.545, -0.23, 51.565];

function userSpec() {
  return defaultMapSpec({
    bbox,
    exaggeration: 18,
    sunkenFrame: { enabled: true, wallMm: 12 },
    title: 'Neasden',
  });
}

function depth(): NonNullable<ImageAsset['depth']> {
  return {
    w: 2,
    h: 2,
    minM: 0,
    maxM: 40,
    nearM: 0,
    farM: 40,
    data: 'AA==',
    settings: { near: 0, far: 40, spacing: 'linear', curve: 1, flatten: 0, matte: false, resolution: 256, invert: false },
  };
}

describe('applyBuiltMapAsset', () => {
  it('keeps user exaggeration, sunken frame, and params when a build finishes', () => {
    let p = newProject();
    p.params.masterScale = '1.4';
    p.params.baseLength = '640';
    const spec = userSpec();
    p = projectWithTopMapSpec(p, spec);
    expect(p.params.masterScale).toBe('1.4');

    const builtKey = mapBuildKey(p.images.top!.map!);
    const asset: ImageAsset = {
      name: 'built terrain',
      dataUrl: 'data:image/png;base64,xx',
      depth: depth(),
      map: {
        ...spec,
        buildKey: builtKey,
        exaggeration: 21,
        exaggerationFactor: 18,
        exaggerationReadout: '×18',
        sunkenFrame: { enabled: false },
        resolvedSource: 'terrarium',
        fetchedAt: '2026-10-16T00:00:00.000Z',
      },
    };

    const next = applyBuiltMapAsset(p, asset);
    expect(next).not.toBeNull();
    expect(next!.params.masterScale).toBe('1.4');
    expect(next!.params.baseLength).toBe('640');
    expect(next!.images.top!.map!.exaggeration).toBe(18);
    expect(next!.images.top!.map!.sunkenFrame).toEqual({ enabled: true, wallMm: 12 });
    expect(next!.images.top!.map!.exaggerationReadout).toBe('×18');
    expect(next!.images.top!.map!.resolvedSource).toBe('terrarium');
    expect(next!.images.top!.depth).toEqual(asset.depth);
    expect(mapBuildKey(next!.images.top!.map!)).toBe(builtKey);
    expect(next!.images.top!.map!.buildKey).toBe(builtKey);
  });

  it('drops a stale build after the user changes the spec', () => {
    let p = newProject();
    p = projectWithTopMapSpec(p, userSpec());
    const oldKey = mapBuildKey(p.images.top!.map!);
    p = projectWithTopMapSpec(p, { ...userSpec(), exaggeration: 12 });
    expect(mapBuildKey(p.images.top!.map!)).not.toBe(oldKey);

    const asset: ImageAsset = {
      name: 'stale',
      dataUrl: 'data:image/png;base64,xx',
      depth: depth(),
      map: { ...userSpec(), buildKey: oldKey, exaggerationReadout: '×18' },
    };
    expect(applyBuiltMapAsset(p, asset)).toBeNull();
    expect(p.images.top!.map!.exaggeration).toBe(12);
    expect(p.images.top!.depth).toBeUndefined();
  });
});
