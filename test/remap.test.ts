import { describe, expect, it } from 'vitest';
import { newProject, type Project } from '../src/core/project';
import { keepPlatesInPlace } from '../src/core/remap';

const move = { t: [0, 0, 20] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] };

function project(params: Record<string, string>, extra: Partial<Project> = {}): Project {
  const p = newProject();
  return { ...p, params: { ...p.params, insShape: 'none', spacingMode: 'gapCount', plateGap: '12', thickness: '3', ...params }, ...extra };
}

describe('moves and materials follow their plate when the count changes', () => {
  const app = { buckets: [{ id: 'b1', name: 'Alu', material: 'aluminium' }], assign: { P0: 'b1', P4: 'b1', P8: 'b1' } };

  it('more plates: entries move to the plate standing in the same spot', () => {
    const prev = project({ plateCount: '9' }, { moves: { P0: move }, appearance: app });
    const next = { ...prev, params: { ...prev.params, plateCount: '11' } };
    const r = keepPlatesInPlace(prev, next);
    expect(Object.keys(r.project.moves!)).toEqual(['P1']);
    expect(r.project.appearance!.assign).toEqual({ P1: 'b1', P5: 'b1', P9: 'b1' });
    expect(r.message).toMatch(/kept 1 moved and 3 painted plates in place/);
  });

  it('fewer plates: entries on plates that are gone are cleared', () => {
    const prev = project({ plateCount: '9' }, { appearance: app });
    const r = keepPlatesInPlace(prev, { ...prev, params: { ...prev.params, plateCount: '7' } });
    expect(r.project.appearance!.assign).toEqual({ P3: 'b1' });
    expect(r.message).toMatch(/cleared 2 entries/);
  });

  it('same count (new gap) keeps every key', () => {
    const prev = project({ plateCount: '9' }, { moves: { P0: move }, appearance: app });
    const next = { ...prev, params: { ...prev.params, plateGap: '20' } };
    const r = keepPlatesInPlace(prev, next);
    expect(r.project).toBe(next);
    expect(r.message).toBeNull();
  });

  it('another slicing mode leaves them for when it comes back', () => {
    const prev = project({ plateCount: '9' }, { appearance: app });
    const next = { ...prev, params: { ...prev.params, sliceMode: 'radial' } };
    expect(keepPlatesInPlace(prev, next).project).toBe(next);
  });

  it('radial: picks stay at their angle', () => {
    const prev = project({ sliceMode: 'radial', radialCount: '12' }, { appearance: { ...app, assign: { R3: 'b1' } } });
    const r = keepPlatesInPlace(prev, { ...prev, params: { ...prev.params, radialCount: '24' } });
    expect(r.project.appearance!.assign).toEqual({ R6: 'b1' });
  });
});
