import { describe, expect, it } from 'vitest';
import { evaluateParams, GROUP_IDLE, GROUPS, defaultRaw } from '../src/core/params';

const idleIn = (patch: Record<string, string | boolean>) => {
  const v = evaluateParams({ ...defaultRaw(), ...patch }).values;
  return GROUPS.filter((g) => GROUP_IDLE[g]?.(v));
};

describe('panels that do nothing in the current setup', () => {
  it('none by default', () => expect(idleIn({})).toEqual(['Steel base', 'Source form']));
  it('steel base: no concrete, support or mould', () => {
    const idle = idleIn({ baseMaterial: 'steel', insShape: 'none' });
    expect(idle).toEqual(expect.arrayContaining(['Support', 'Concrete', 'Mould']));
    expect(idle).not.toContain('Steel base');
  });
  it('radial: no bracing', () => expect(idleIn({ sliceMode: 'radial' })).toContain('Bracing'));
  it('flat stack: no bracing or tuning', () => expect(idleIn({ sliceMode: 'flat' })).toEqual(expect.arrayContaining(['Bracing', 'Tuning'])));
  it('waffle: no tuning, bracing still used', () => {
    const g = idleIn({ sliceMode: 'waffle' });
    expect(g).toContain('Tuning');
    expect(g).not.toContain('Bracing');
  });
  it('source form: strata and tuning idle, source form in use', () => {
    const g = idleIn({ stackSource: 'form' });
    expect(g).toEqual(expect.arrayContaining(['Strata', 'Tuning']));
    expect(g).not.toContain('Source form');
  });
  it('no base: support idle', () => expect(idleIn({ baseOn: false })).toContain('Support'));
});
