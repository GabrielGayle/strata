import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets, type Model } from '../src/core/pipeline';
import { deserialize, newProject, serialize } from '../src/core/project';
import { newObject, type CutObject } from '../src/core/objects';
import { DEFAULT_SHELF, MAGENTA_EYE_SHELF, SHELF_SOLVE_KEYS, cleanShelf, clearShelfOverride, commitShelfLock, shelfCards, withShelfOverride } from '../src/core/shelf';
import { formatSolverDelta, layoutShelf, solveUnobstructed, solverDeltas } from '../src/core/shelfSolve';
import { assertExportable, fitExportErrors } from '../src/core/exporters';
import {
  DEFAULT_FLEX_MM,
  DEFAULT_MAX_HIDDEN_PCT,
  DEFAULT_MAX_OVERLAP_MM,
  DEFAULT_VIEW_AZIMUTH,
  DEFAULT_VIEW_ELEVATION,
  cardVisibility,
  formatCameraNote,
  viewSettings,
  type UnobstructedView,
} from '../src/core/shelfView';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

function card(partial: Partial<CutObject> & { id: string; name: string }): CutObject {
  const base = newObject('card', [], { y: 50 });
  return { ...base, w: 100, h: 80, d: 0.4, x: 0, y: 50, z: 0, rx: 0, ry: 0, rz: 0, clearance: 0.5, on: true, ...partial };
}

const headOn: UnobstructedView = {
  azimuth: 0,
  elevation: 0,
  maxOverlapMm: DEFAULT_MAX_OVERLAP_MM,
  maxHiddenPct: DEFAULT_MAX_HIDDEN_PCT,
  flexMm: DEFAULT_FLEX_MM,
  unobstructed: false,
};

const pose = (o: CutObject) => [o.id, o.x, o.y, o.z, o.rx, o.ry, o.rz, o.w, o.h, o.d];

describe('postcard face visibility', () => {
  it('treats two fully overlapping cards as the rear one hidden', () => {
    const back = card({ id: 'shelf1', name: 'Back', z: 0 });
    const front = card({ id: 'shelf2', name: 'Front', z: 8 });
    const r = cardVisibility([back, front], headOn);
    const b = r.cards.find((c) => c.id === 'shelf1')!;
    const f = r.cards.find((c) => c.id === 'shelf2')!;
    expect(b.hiddenPct).toBeGreaterThan(80);
    expect(b.over).toBe(true);
    expect(f.over).toBe(false);
    expect(f.hiddenPct).toBeLessThan(1);
  });

  it('allows a corner-only touch within overlap and flex', () => {
    // 1 mm × 1 mm overlap at the top-right corner, well inside 2 mm + 1.5 mm flex.
    const back = card({ id: 'shelf1', name: 'Back', z: 0 });
    const front = card({ id: 'shelf2', name: 'Front', x: 99, y: 129, z: 8 });
    const r = cardVisibility([back, front], headOn);
    const b = r.cards.find((c) => c.id === 'shelf1')!;
    expect(b.over).toBe(false);
    expect(b.hiddenPct).toBeLessThan(DEFAULT_MAX_HIDDEN_PCT);
  });

  it('reports a clear pair with no occlusion', () => {
    const left = card({ id: 'shelf1', name: 'Left', x: -80, z: 0 });
    const right = card({ id: 'shelf2', name: 'Right', x: 80, z: 0 });
    const r = cardVisibility([left, right], headOn);
    expect(r.hiddenCount).toBe(0);
    expect(r.cards.every((c) => c.hiddenArea < 0.5 && !c.over)).toBe(true);
  });
});

describe('unobstructed view solver', () => {
  it('clears the magenta-eye arch at the default iso angle', () => {
    const spec = { ...MAGENTA_EYE_SHELF, unobstructed: true as const };
    const { spec: solved, report } = solveUnobstructed(spec, 120);
    expect(report.hiddenCount).toBe(0);
    const placed = layoutShelf(solved, 120);
    const vis = cardVisibility(placed, viewSettings(solved));
    expect(vis.hiddenCount).toBe(0);
    expect(vis.cards.length).toBe(7);
  });

  it('does not clobber a gap the user typed', () => {
    const spec = { ...MAGENTA_EYE_SHELF, unobstructed: true as const, gap: 0, overrides: { gap: true as const } };
    const { spec: solved } = solveUnobstructed(spec, 120);
    expect(solved.gap).toBe(0);
  });
});

describe('unobstructed off is identical to the previous shelf', () => {
  it('keeps placement byte-identical when the flag is missing or false', () => {
    const arch = { ...DEFAULT_SHELF, layout: 'arch' as const };
    const a = shelfCards(arch, 120).map(pose);
    const b = layoutShelf({ ...arch, unobstructed: false }, 120).map(pose);
    const c = layoutShelf(arch, 120).map(pose);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('leaves existing project JSON without new shelf keys', () => {
    const p = { ...newProject(), shelf: { ...DEFAULT_SHELF, layout: 'arch' as const } };
    const raw = JSON.parse(serialize(p));
    expect(raw.shelf.unobstructed).toBeUndefined();
    expect(raw.shelf.viewAzimuth).toBeUndefined();
    expect(raw.shelf.maxOverlapMm).toBeUndefined();
    expect(raw.shelf.flexMm).toBeUndefined();
    expect(raw.shelf.tintHidden).toBeUndefined();
    expect(raw.shelf.overrides).toBeUndefined();
    const back = deserialize(serialize(p));
    expect(back.shelf).toEqual(p.shelf);
    expect(cleanShelf(raw.shelf)?.unobstructed).toBeUndefined();
  });

  it('does not move plates or cards when the flag is off', () => {
    const compute = createPipeline();
    const shelf = { ...DEFAULT_SHELF, layout: 'arch' as const };
    const m0 = compute({ ...newProject(), shelf }, assets);
    const m1 = compute({ ...newProject(), shelf: { ...shelf, unobstructed: false } }, assets);
    expect(m1.objects.map((o) => pose(o.object))).toEqual(m0.objects.map((o) => pose(o.object)));
    expect(m1.sliced.parts.map((p) => [p.id, +p.area.toFixed(3)])).toEqual(m0.sliced.parts.map((p) => [p.id, +p.area.toFixed(3)]));
  });
});

describe('solver-used placement values', () => {
  it('formats a moved number as stored → solver', () => {
    expect(formatSolverDelta('radius', 260, 410)).toBe('radius 260 → solver 410');
    expect(formatSolverDelta('lean', 12, 8.5)).toBe('lean 12 → solver 8.5');
  });

  it('lists the magenta-eye fields the solver actually used', () => {
    const spec = { ...MAGENTA_EYE_SHELF, unobstructed: true as const };
    const { spec: solved, adjusted } = solveUnobstructed(spec, 120);
    expect(adjusted).toBe(true);
    const lines = solverDeltas(spec, solved);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((t) => / → solver /.test(t))).toBe(true);
  });

  it('puts those used values on the model', () => {
    const compute = createPipeline();
    const spec = { ...MAGENTA_EYE_SHELF, unobstructed: true as const };
    const m = compute({ ...newProject(), shelf: spec }, assets);
    expect(m.shelfSolve?.adjusted).toBe(true);
    expect(solverDeltas(spec, m.shelfSolve!.spec).length).toBeGreaterThan(0);
  });
});

describe('typed-value locks', () => {
  it('does not lock a field when the typed value is unchanged', () => {
    const s = { ...DEFAULT_SHELF, radius: 260 };
    const next = withShelfOverride(s, { radius: 260 }, ['radius']);
    expect(next).toBe(s);
    expect(next.overrides).toBeUndefined();
  });

  it('locks a field when the typed value changes', () => {
    const s = { ...DEFAULT_SHELF, radius: 260 };
    const next = withShelfOverride(s, { radius: 410 }, ['radius']);
    expect(next.radius).toBe(410);
    expect(next.overrides?.radius).toBe(true);
  });

  it('clears a lock so the solver may move the field again', () => {
    const locked = withShelfOverride({ ...DEFAULT_SHELF, radius: 260 }, { radius: 410 }, ['radius']);
    expect(locked.overrides?.radius).toBe(true);
    const unlocked = clearShelfOverride(locked, ['radius']);
    expect(unlocked.overrides).toBeUndefined();
    expect(unlocked.radius).toBe(410);
  });

  it('keeps an existing lock when the same number is typed again', () => {
    const locked = withShelfOverride({ ...DEFAULT_SHELF, radius: 260 }, { radius: 300 }, ['radius']);
    const again = withShelfOverride(locked, { radius: 300 }, ['radius']);
    expect(again).toBe(locked);
    expect(again.overrides?.radius).toBe(true);
  });

  it('does not lock when the same number is typed key by key', () => {
    const from = 300;
    let s = { ...DEFAULT_SHELF, radius: 300 };
    for (const n of [3, 30, 300]) s = { ...s, radius: n };
    s = commitShelfLock(s, 'radius', from);
    expect(s.radius).toBe(300);
    expect(s.overrides).toBeUndefined();
  });

  it('does not lock when the last digit is deleted and retyped', () => {
    const from = 300;
    let s = { ...DEFAULT_SHELF, radius: 300 };
    s = { ...s, radius: 30 };
    s = { ...s, radius: 300 };
    s = commitShelfLock(s, 'radius', from);
    expect(s.radius).toBe(300);
    expect(s.overrides).toBeUndefined();
  });

  it('locks on blur only if the number differs from the value at focus', () => {
    const from = 300;
    let s = { ...DEFAULT_SHELF, radius: 300 };
    for (const n of [3, 31, 310]) s = { ...s, radius: n };
    s = commitShelfLock(s, 'radius', from);
    expect(s.radius).toBe(310);
    expect(s.overrides?.radius).toBe(true);
  });
});

describe('hidden cards are a warning, not an export error', () => {
  it('names each hidden card and its % when Unobstructed view is on', () => {
    const overrides = Object.fromEntries(SHELF_SOLVE_KEYS.map((k) => [k, true as const])) as Record<(typeof SHELF_SOLVE_KEYS)[number], true>;
    const spec = { ...MAGENTA_EYE_SHELF, unobstructed: true as const, overrides };
    const vis = cardVisibility(shelfCards(spec, 120), viewSettings(spec));
    expect(vis.hiddenCount).toBeGreaterThan(0);
    const hidden = vis.issues.filter((i) => i.type === 'hidden');
    expect(hidden.every((i) => i.severity === 'warn')).toBe(true);
    expect(hidden.some((i) => /%\s*hidden/.test(i.message))).toBe(true);
    expect(hidden.some((i) => /Magenta|Eye/.test(i.message))).toBe(true);
    const model = { issues: vis.issues } as Model;
    expect(fitExportErrors(model)).toEqual([]);
    expect(() => assertExportable(model)).not.toThrow();
  });

  it('keeps hidden cards as info when Unobstructed view is off', () => {
    const vis = cardVisibility(shelfCards(MAGENTA_EYE_SHELF, 120), viewSettings({ ...MAGENTA_EYE_SHELF, unobstructed: false }));
    expect(vis.hiddenCount).toBeGreaterThan(0);
    expect(vis.issues.filter((i) => i.type === 'hidden').every((i) => i.severity === 'info')).toBe(true);
  });
});

describe('view defaults', () => {
  it('derives the camera note from the loaded project, not a leftover live angle', () => {
    const live = { azimuth: 37, elevation: 26 };
    expect(formatCameraNote({ viewAzimuth: 70, viewElevation: 10 }, live)).toBe('Camera 70° az / 10° el.');
    expect(formatCameraNote({ viewAzimuth: 37, viewElevation: 26 }, live)).toBe('Camera 37° az / 26° el.');
  });

  it('match the iso camera and the sensible overlap pair', () => {
    const v = viewSettings(undefined);
    expect(v.azimuth).toBeCloseTo(DEFAULT_VIEW_AZIMUTH, 8);
    expect(v.elevation).toBeCloseTo(DEFAULT_VIEW_ELEVATION, 8);
    expect(v.maxOverlapMm).toBe(2);
    expect(v.maxHiddenPct).toBe(2);
    expect(v.flexMm).toBe(1.5);
    expect(v.unobstructed).toBe(false);
  });
});
