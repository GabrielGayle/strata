import { describe, expect, it } from 'vitest';
import {
  addCustom,
  controlsIn,
  defaultLayout,
  moveControl,
  movePanel,
  moveSideTab,
  normaliseLayout,
  nudgeControl,
  nudgePanel,
  removeCustom,
  resetPanel,
  sendHome,
  type Known,
} from '../src/core/panelLayout';
import { KNOWN } from '../src/state/panelLayout';

const K: Known = {
  a: ['p:A', 'p:B', 'p:C'],
  b: ['i:x', 'i:y'],
  controls: [
    { id: 'a1', home: 'p:A' },
    { id: 'a2', home: 'p:A' },
    { id: 'a3', home: 'p:A' },
    { id: 'b1', home: 'p:B' },
    { id: 'b2', home: 'p:B' },
    { id: 'c1', home: 'p:C' },
  ],
  accepts: (p) => p.startsWith('p:'),
  sideTabs: ['t1', 't2', 't3'],
};

describe('panel layout', () => {
  it('starts with every panel and control where it belongs', () => {
    const l = defaultLayout(K);
    expect(l.a).toEqual(K.a);
    expect(l.b).toEqual(K.b);
    expect(controlsIn(l, 'p:A', K)).toEqual(['a1', 'a2', 'a3']);
  });

  it('moves panels within and across columns', () => {
    let l = movePanel(defaultLayout(K), 'p:C', 'a', 'p:A');
    expect(l.a).toEqual(['p:C', 'p:A', 'p:B']);
    l = movePanel(l, 'i:y', 'a', null);
    expect(l.a).toEqual(['p:C', 'p:A', 'p:B', 'i:y']);
    expect(l.b).toEqual(['i:x']);
    l = nudgePanel(l, 'p:C', 1);
    expect(l.a).toEqual(['p:A', 'p:C', 'p:B', 'i:y']);
    expect(nudgePanel(l, 'p:A', -1)).toBe(l);
  });

  it('moving a panel into a hidden column shows the column', () => {
    const l = { ...defaultLayout(K), hide: { a: false, b: true } };
    expect(movePanel(l, 'p:A', 'b', null).hide.b).toBe(false);
  });

  it('reorders controls and moves them between panels', () => {
    let l = moveControl(defaultLayout(K), 'a3', 'p:A', 'a1', K);
    expect(controlsIn(l, 'p:A', K)).toEqual(['a3', 'a1', 'a2']);
    l = moveControl(l, 'a1', 'p:B', 'b2', K);
    expect(controlsIn(l, 'p:A', K)).toEqual(['a3', 'a2']);
    expect(controlsIn(l, 'p:B', K)).toEqual(['b1', 'a1', 'b2']);
    expect(l.moved).toEqual({ a1: 'p:B' });
    // back home drops the move
    l = moveControl(l, 'a1', 'p:A', null, K);
    expect(l.moved).toEqual({});
    expect(controlsIn(l, 'p:A', K)).toEqual(['a3', 'a2', 'a1']);
  });

  it('refuses panels that take no controls', () => {
    const l = defaultLayout(K);
    expect(moveControl(l, 'a1', 'i:x', null, K)).toBe(l);
    expect(moveControl(l, 'zz', 'p:B', null, K)).toBe(l);
  });

  it('arrow steps cross into the next panel at either end', () => {
    let l = nudgeControl(defaultLayout(K), 'a3', 1, K);
    expect(controlsIn(l, 'p:B', K)).toEqual(['a3', 'b1', 'b2']);
    l = nudgeControl(l, 'a3', -1, K);
    expect(controlsIn(l, 'p:A', K)).toEqual(['a1', 'a2', 'a3']);
    expect(l.moved).toEqual({});
  });

  it('custom panels take controls, and give them back when removed', () => {
    const { layout, id } = addCustom(defaultLayout(K), 'Favourites', 'a', 'custom:fav');
    expect(layout.a[0]).toBe(id);
    let l = moveControl(layout, 'b2', id, null, K);
    l = moveControl(l, 'a1', id, 'b2', K);
    expect(controlsIn(l, id, K)).toEqual(['a1', 'b2']);
    l = removeCustom(l, id);
    expect(l.a).toEqual(K.a);
    expect(l.moved).toEqual({});
    expect(controlsIn(l, 'p:B', K)).toEqual(['b1', 'b2']);
  });

  it('sendHome and resetPanel put controls back', () => {
    let l = moveControl(defaultLayout(K), 'a1', 'p:B', null, K);
    l = moveControl(l, 'c1', 'p:A', null, K);
    l = moveControl(l, 'a3', 'p:A', 'a2', K);
    expect(sendHome(l, 'a1').moved).toEqual({ c1: 'p:A' });
    const r = resetPanel(l, 'p:A', K);
    expect(r.moved).toEqual({});
    expect(controlsIn(r, 'p:A', K)).toEqual(['a1', 'a2', 'a3']);
    expect(controlsIn(r, 'p:C', K)).toEqual(['c1']);
  });

  it('never loses a panel or control, whatever was saved', () => {
    const junk = {
      a: ['p:B', 'gone', 'p:B', 7],
      b: ['p:A'],
      moved: { a1: 'nowhere', b1: 'i:x', c1: 'p:A', zz: 'p:A' },
      order: { 'p:A': ['c1', 'c1', 'nope'], ghost: ['a1'] },
      custom: [{ id: 'custom:k', name: 'Kept' }, { id: 'bad', name: 'x' }],
      widths: { a: 5, b: 99999 },
      sideTabs: ['t3', 'old'],
    };
    const l = normaliseLayout(junk, K);
    expect([...l.a, ...l.b].sort()).toEqual([...K.a, ...K.b, 'custom:k'].sort());
    expect(l.b).toEqual(['i:x', 'i:y', 'p:A']);
    expect(l.moved).toEqual({ c1: 'p:A' });
    expect(l.order).toEqual({ 'p:A': ['c1'] });
    expect(l.widths.a).toBeGreaterThanOrEqual(200);
    expect(l.widths.b).toBeLessThanOrEqual(640);
    expect(l.sideTabs).toEqual(['t1', 't2', 't3']);
    for (const c of K.controls) expect([...l.a, ...l.b].some((p) => controlsIn(l, p, K).includes(c.id))).toBe(true);
    expect(normaliseLayout('garbage', K)).toEqual(defaultLayout(K));
  });

  it('a panel added to the app later appears next to its usual neighbour', () => {
    const l = normaliseLayout({ a: ['p:C', 'p:A'], b: ['i:x', 'i:y'] }, K);
    expect(l.a).toEqual(['p:C', 'p:A', 'p:B']);
  });

  it('reorders the 3D sidebar tabs', () => {
    const l = moveSideTab(defaultLayout(K), 't3', 't1');
    expect(l.sideTabs).toEqual(['t3', 't1', 't2']);
  });

  it('the app knows every parameter panel and control', () => {
    expect(KNOWN.a.length).toBeGreaterThan(10);
    expect(KNOWN.b).toContain('insp:export');
    const panels = new Set(KNOWN.a);
    for (const c of KNOWN.controls) expect(panels.has(c.home)).toBe(true);
  });
});
