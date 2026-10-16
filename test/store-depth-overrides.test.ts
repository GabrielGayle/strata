import { describe, expect, it } from 'vitest';
import type { DepthData } from '../src/core/depth';
import { mergeDepthAfterRebuild, markDepthSettingOverrides } from '../src/core/depthOverrides';
import { applyProjectPatch, masterSizePatch } from '../src/core/design';
import { applyParamPatchRespectingOverrides, markUserParamOverrides } from '../src/core/projectOverrides';
import { newProject } from '../src/core/project';
import { mapGridToDepth } from '../src/core/mapToDepth';
import { syntheticConeGrid } from '../src/core/mapToDepth';
import { defaultMapSpec } from '../src/core/mapSpec';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

function sampleDepth(overrides?: Partial<DepthData['settings']>, settingsOverrides?: DepthData['settingsOverrides']): DepthData {
  const { depth } = mapGridToDepth(syntheticConeGrid(32), { exaggeration: 8 });
  return {
    ...depth,
    settings: { ...depth.settings, near: 2.5, far: 40, ...overrides },
    settingsOverrides: settingsOverrides ?? markDepthSettingOverrides(undefined, { near: 2.5, far: 40, ...overrides }),
  };
}

describe('depth near/far user overrides', () => {
  it('survives map terrain depth rebuild', () => {
    const prev = sampleDepth();
    const { depth: fresh } = mapGridToDepth(syntheticConeGrid(32), { exaggeration: 12 });
    const merged = mergeDepthAfterRebuild(prev, fresh);
    expect(merged.settings.near).toBe(2.5);
    expect(merged.settings.far).toBe(40);
    expect(fresh.settings.near).not.toBe(2.5);
  });

  it('auto-fills when the user has not overridden near/far', () => {
    const prev: DepthData = { ...sampleDepth(), settingsOverrides: undefined };
    const { depth: fresh } = mapGridToDepth(syntheticConeGrid(32), { exaggeration: 12 });
    const merged = mergeDepthAfterRebuild(prev, fresh);
    expect(merged.settings.near).toBe(fresh.settings.near);
    expect(merged.settings.far).toBe(fresh.settings.far);
  });
});

describe('param overrides (size / tuning)', () => {
  it('blocks design master-size patch when base outline was user-set', () => {
    let p = newProject();
    p = { ...p, params: { ...p.params, baseWidth: '210', baseLength: '297' }, userParamOverrides: { baseWidth: true, baseLength: true } };
    const next = applyProjectPatch(p, masterSizePatch('a3', 'portrait'));
    expect(next.params.baseWidth).toBe('210');
    expect(next.params.baseLength).toBe('297');
  });

  it('allows master-size patch when outline is not user-overridden', () => {
    const p = newProject();
    const next = applyProjectPatch(p, masterSizePatch('a4', 'portrait'));
    expect(next.params.baseWidth).toBe('210');
    expect(next.params.baseLength).toBe('297');
  });

  it('blocks auto-dimension param writes for overridden ids', () => {
    const params = { stackLength: '100', plateCount: '12' };
    const overrides = markUserParamOverrides(undefined, ['stackLength']);
    const out = applyParamPatchRespectingOverrides(params, { stackLength: '80', plateCount: '20' }, overrides);
    expect(out.stackLength).toBe('100');
    expect(out.plateCount).toBe('20');
  });
});

describe('map spec + depth overrides integration', () => {
  it('queued map spec does not clear depth settings on project patch', () => {
    const depth = sampleDepth();
    let p = newProject();
    p = {
      ...p,
      images: {
        top: { name: 'Map', dataUrl: 'data:image/png;base64,abc', map: defaultMapSpec({ bbox: NEASDEN_FAST_BBOX }), depth },
      },
    };
    p = applyProjectPatch(p, { map: { title: 'Neasden', source: 'ea-dtm' } });
    expect(p.images.top?.depth?.settings.near).toBe(2.5);
    expect(p.images.top?.map?.title).toBe('Neasden');
  });
});
