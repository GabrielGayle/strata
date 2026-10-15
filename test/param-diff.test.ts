import { describe, expect, it } from 'vitest';
import { changedByGroup, changedIds, isDefault, resetGroupPatch } from '../src/core/paramDiff';
import { PARAM_MAP, defaultRaw } from '../src/core/params';

describe('changed-only parameters', () => {
  it('a fresh project has nothing changed', () => {
    expect(changedIds(defaultRaw())).toEqual([]);
    expect(changedByGroup(defaultRaw())).toEqual({});
    expect(changedIds({})).toEqual([]);
  });

  it('treats equal spellings as the default', () => {
    expect(isDefault(PARAM_MAP.baseLength, '800')).toBe(true);
    expect(isDefault(PARAM_MAP.baseLength, '800.0')).toBe(true);
    expect(isDefault(PARAM_MAP.baseLength, 800)).toBe(true);
    expect(isDefault(PARAM_MAP.baseLength, '801')).toBe(false);
    expect(isDefault(PARAM_MAP.baseLength, 'baseWidth * 2')).toBe(false);
    expect(isDefault(PARAM_MAP.baseOn, 'true')).toBe(true);
    expect(isDefault(PARAM_MAP.baseOn, false)).toBe(false);
    expect(isDefault(PARAM_MAP.concreteTint, String(PARAM_MAP.concreteTint.def).toUpperCase())).toBe(true);
  });

  it('groups changes by panel and resets one panel only', () => {
    const p = { ...defaultRaw(), baseLength: '900', baseOn: false, masterScale: '0.5', partPrefix: 'X' };
    const by = changedByGroup(p);
    expect(by.Base.sort()).toEqual(['baseLength', 'baseOn']);
    expect(by.Master).toEqual(['masterScale']);
    expect(by.Fabrication).toEqual(['partPrefix']);
    const patch = resetGroupPatch(p, 'Base');
    expect(patch).toEqual({ baseLength: PARAM_MAP.baseLength.def, baseOn: true });
    const after = { ...p, ...patch };
    expect(changedByGroup(after).Base).toBeUndefined();
    expect(changedIds(after)).toEqual(['masterScale', 'partPrefix']);
    expect(resetGroupPatch(after, 'Base')).toEqual({});
  });
});
