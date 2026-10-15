import { describe, expect, it } from 'vitest';
import { dockFloat, findTab, moveTab, normalise, pane, panes, revealTab, setRatio, split, visibleTabs, zoneAt, type Layout } from '../src/core/workspace';
import { ALL_TABS, PRESETS } from '../src/state/workspaces';

const tabsOf = (l: Layout) => [...panes(l.root), ...l.floats].flatMap((p) => p.tabs).sort();
const single = (): Layout => ({ root: pane(['3d', 'plates', 'image'], '3d', 'p1'), floats: [] });

describe('workspace layouts', () => {
  it('splits a pane when a tab is dropped on its edge', () => {
    const l = moveTab(single(), 'image', { pane: 'p1', zone: 'left' });
    expect(l.root.kind).toBe('split');
    if (l.root.kind !== 'split') return;
    expect(l.root.dir).toBe('row');
    expect(l.root.a).toMatchObject({ tabs: ['image'], active: 'image' });
    expect(l.root.b).toMatchObject({ id: 'p1', tabs: ['3d', 'plates'] });
    expect(visibleTabs(l).sort()).toEqual(['3d', 'image']);
  });

  it('stacks for top and bottom drops', () => {
    const l = moveTab(single(), 'plates', { pane: 'p1', zone: 'bottom' });
    expect(l.root.kind === 'split' && l.root.dir).toBe('col');
    expect(l.root.kind === 'split' && l.root.b).toMatchObject({ tabs: ['plates'] });
  });

  it('closes up a pane whose last tab moves away', () => {
    let l = moveTab(single(), 'image', { pane: 'p1', zone: 'right' });
    const fresh = findTab(l, 'image')!.id;
    l = moveTab(l, 'image', { pane: 'p1', zone: 'center' });
    expect(l.root).toMatchObject({ kind: 'pane', id: 'p1', active: 'image' });
    expect(panes(l.root)).toHaveLength(1);
    expect(findTab(l, 'image')!.id).not.toBe(fresh);
  });

  it('ignores dropping a lone tab onto its own pane edge, and never empties the docked area', () => {
    const l: Layout = { root: pane(['3d'], '3d', 'p1'), floats: [] };
    expect(moveTab(l, '3d', { pane: 'p1', zone: 'left' }).root).toBe(l.root);
    expect(moveTab(l, '3d', { float: { x: 10, y: 10 } })).toBe(l);
  });

  it('floats a tab and docks it back', () => {
    let l = moveTab(single(), 'plates', { float: { x: 30, y: 40 } });
    expect(l.floats).toHaveLength(1);
    expect(l.floats[0]).toMatchObject({ tabs: ['plates'], x: 30, y: 40 });
    expect(panes(l.root)[0].tabs).toEqual(['3d', 'image']);
    // a lone floating tab dragged to float again just moves the window
    l = moveTab(l, 'plates', { float: { x: 90, y: 50 } });
    expect(l.floats).toHaveLength(1);
    expect(l.floats[0]).toMatchObject({ x: 90, y: 50 });
    // tabs can join a float
    l = moveTab(l, 'image', { pane: l.floats[0].id, zone: 'center' });
    expect(l.floats[0].tabs).toEqual(['plates', 'image']);
    l = dockFloat(l, l.floats[0].id);
    expect(l.floats).toHaveLength(0);
    expect(panes(l.root)[0].tabs).toEqual(['3d', 'plates', 'image']);
  });

  it('reveals a tab in whichever pane holds it', () => {
    let l = moveTab(single(), 'image', { pane: 'p1', zone: 'right' });
    l = revealTab(l, 'plates');
    expect(visibleTabs(l).sort()).toEqual(['image', 'plates']);
    expect(revealTab(l, 'plates')).toBe(l);
  });

  it('keeps every tab exactly once through any sequence of moves', () => {
    let l = PRESETS[0].make();
    const zones = ['left', 'right', 'top', 'bottom', 'center'] as const;
    for (let i = 0; i < 200; i++) {
      const t = ALL_TABS[(i * 7) % ALL_TABS.length];
      const targets = [...panes(l.root), ...l.floats];
      const target = targets[(i * 3) % targets.length];
      l = i % 11 === 5 ? moveTab(l, t, { float: { x: i, y: i } }) : moveTab(l, t, { pane: target.id, zone: zones[i % zones.length] });
      if (i % 17 === 0 && l.floats.length) l = dockFloat(l, l.floats[0].id);
      expect(tabsOf(l)).toEqual([...ALL_TABS].sort());
    }
  });

  it('clamps divider ratios', () => {
    const l: Layout = { root: split('row', pane(['3d']), pane(['image']), 0.5, 's1'), floats: [] };
    expect(setRatio(l, 's1', 2).root).toMatchObject({ ratio: 0.88 });
    expect(setRatio(l, 's1', -1).root).toMatchObject({ ratio: 0.12 });
  });

  it('picks the zone from where the pointer is', () => {
    expect(zoneAt(5, 50, 100, 100)).toBe('left');
    expect(zoneAt(95, 50, 100, 100)).toBe('right');
    expect(zoneAt(50, 3, 100, 100)).toBe('top');
    expect(zoneAt(50, 97, 100, 100)).toBe('bottom');
    expect(zoneAt(50, 50, 100, 100)).toBe('center');
  });

  it('repairs stored layouts: unknown and repeated tabs dropped, new tabs added', () => {
    const raw = { root: { kind: 'split', dir: 'row', ratio: 'x', a: { kind: 'pane', tabs: ['3d', 'bogus', '3d'], active: 'bogus' }, b: { kind: 'pane', tabs: ['bogus'] } }, floats: [{ tabs: ['image'], x: 'a' }] };
    const l = normalise(raw, ALL_TABS)!;
    expect(l.root.kind).toBe('pane');
    expect(panes(l.root)[0].tabs[0]).toBe('3d');
    expect(panes(l.root)[0].active).toBe('3d');
    expect(l.floats[0]).toMatchObject({ tabs: ['image'], x: 40 });
    expect(tabsOf(l)).toEqual([...ALL_TABS].sort());
    expect(normalise(null, ALL_TABS)!.root).toMatchObject({ kind: 'pane', tabs: ALL_TABS });
  });

  it('starting workspaces each hold every tab once, and Image + 3D shows both', () => {
    for (const p of PRESETS) expect(tabsOf(p.make())).toEqual([...ALL_TABS].sort());
    expect(visibleTabs(PRESETS.find((p) => p.id === 'image-3d')!.make()).sort()).toEqual(['3d', 'image']);
  });
});
