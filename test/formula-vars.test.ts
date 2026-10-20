import { describe, expect, it } from 'vitest';
import { CONST_VALUES, FUNC_NAMES } from '../src/core/expr';
import { FLAG_NAMES, PARAMS, defaultRaw, evaluateParams } from '../src/core/params';
import { FLAG_LABELS, FUNC_LABELS, formulaVars, insertVar, matchVars, wordAt } from '../src/core/formulaVars';

const ev = evaluateParams({ ...defaultRaw(), sliceMode: 'waffle' });
const vars = formulaVars('crossCount', ev.values, ev.flags, ev.deps);

describe('formula names list', () => {
  it('lists exactly what the evaluator accepts', () => {
    const numeric = PARAMS.filter((p) => p.kind === 'number' && p.id !== 'crossCount').map((p) => p.id);
    const names = vars.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => vars.find((v) => v.name === n)!.kind === 'param').sort()).toEqual([...numeric].sort());
    for (const f of FLAG_NAMES) expect(names).toContain(f);
    for (const f of FUNC_NAMES) expect(names).toContain(f);
    for (const c of Object.keys(CONST_VALUES).filter((c) => c !== 'PI')) expect(names).toContain(c);
    expect(names).not.toContain('crossCount');
    // every listed name is accepted by a formula (and blocked ones are the ones that would loop)
    for (const v of vars.filter((v) => v.kind !== 'func')) {
      const r = evaluateParams({ ...defaultRaw(), sliceMode: 'waffle', crossCount: `${v.name} * 0 + 3` });
      expect(r.errors.crossCount, v.name).toBe(v.blocked ? 'Circular reference' : undefined);
    }
    for (const f of FUNC_NAMES) expect(FUNC_LABELS[f], f).toBeTruthy();
    for (const f of FLAG_NAMES) expect(FLAG_LABELS[f], f).toBeTruthy();
  });

  it('shows current values, own panel first', () => {
    expect(vars[0].group).toBe('Slicer');
    expect(vars.find((v) => v.name === 'plateCount')!.value).toBe(ev.values.plateCount);
    expect(vars.find((v) => v.name === 'isWaffle')!.value).toBe(1);
  });

  it('autocompletes and inserts at the caret', () => {
    expect(wordAt('floor(plat', 10)).toEqual({ start: 6, end: 10, word: 'plat' });
    expect(wordAt('2.5', 3).word).toBe('');
    const m = matchVars(vars, 'platec');
    expect(m[0].name).toBe('plateCount');
    expect(insertVar('floor(plat / 2)', 10, 10, { insert: 'plateCount' })).toEqual({ text: 'floor(plateCount / 2)', caret: 16 });
    expect(insertVar('', 0, 0, { insert: 'floor(' })).toEqual({ text: 'floor(', caret: 6 });
    expect(insertVar('flo(x)', 3, 3, { insert: 'floor(' })).toEqual({ text: 'floor(x)', caret: 6 });
  });
});
