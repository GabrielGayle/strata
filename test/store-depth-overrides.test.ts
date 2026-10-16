import { beforeEach, describe, expect, it } from 'vitest';
import type { DepthData } from '../src/core/depth';
import { markDepthSettingOverrides, mergeDepthAfterRebuild } from '../src/core/depthOverrides';
import { applyProjectPatch, masterSizePatch } from '../src/core/design';
import { applyParamPatchRespectingOverrides, markUserParamOverrides } from '../src/core/projectOverrides';
import { newProject } from '../src/core/project';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { defaultMapSpec } from '../src/core/mapSpec';
import { useStore } from '../src/state/store';
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

describe('store: near/far persist across map rebuild, auto-dimension and design patch', () => {
  beforeEach(() => {
    const p = newProject();
    useStore.setState({
      project: p,
      past: [],
      future: [],
      mapTerrain: { phase: 'idle', message: '' },
    });
  });

  it('keeps user near/far, size preset and tuning through rebuild and patches', () => {
    const depth = sampleDepth();
    const map = defaultMapSpec({ bbox: NEASDEN_FAST_BBOX, title: 'Neasden' });
    useStore.getState().replaceProject({
      ...newProject(),
      images: { top: { name: 'Map', dataUrl: 'data:image/png;base64,abc', map, depth } },
    });

    useStore.getState().setDepthSettings('top', { near: 2.5, far: 40 });
    expect(useStore.getState().project.images.top?.depth?.settings.near).toBe(2.5);
    expect(useStore.getState().project.images.top?.depth?.settingsOverrides?.near).toBe(true);

    const { depth: rebuilt } = mapGridToDepth(syntheticConeGrid(24), { exaggeration: 15 });
    useStore.getState().finishMapTerrainBuild({
      name: 'Map terrain',
      dataUrl: 'data:image/png;base64,abc',
      map: { ...map, buildKey: 'k1', exaggerationFactor: 15 },
      depth: rebuilt,
    });
    const afterBuild = useStore.getState().project.images.top?.depth;
    expect(afterBuild?.settings.near).toBe(2.5);
    expect(afterBuild?.settings.far).toBe(40);

    useStore.getState().setParam('baseWidth', '210');
    useStore.getState().setParam('baseLength', '297');
    useStore.getState().setParam('plateCount', '18');
    useStore.getState().applyDesignPatch(masterSizePatch('a3', 'landscape'), 'size');
    expect(useStore.getState().project.params.baseWidth).toBe('210');
    expect(useStore.getState().project.params.baseLength).toBe('297');

    useStore.getState().applyDesignPatch({ autoDimension: { faces: ['top'], reliefExaggeration: 2 } }, 'auto-dim');
    expect(useStore.getState().project.images.top?.depth?.settings.near).toBe(2.5);
    expect(useStore.getState().project.params.plateCount).toBe('18');

    useStore.getState().applyDesignPatch({ map: { title: 'Neasden live' } }, 'map-title');
    expect(useStore.getState().project.images.top?.depth?.settings.near).toBe(2.5);
    expect(useStore.getState().project.images.top?.map?.title).toBe('Neasden live');

    useStore.getState().resetDepthToAuto('top');
    const afterReset = useStore.getState().project.images.top?.depth;
    expect(afterReset?.settingsOverrides?.near).toBeUndefined();
    expect(afterReset?.settings.near).toBe(afterReset?.nearM);
    expect(afterReset?.settings.far).toBe(afterReset?.farM);
  });
});
