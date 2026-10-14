import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject, applyPreset } from '../src/core/project';
import { SOUND_PRESETS } from '../src/core/soundPresets';
import { arrange, cantileverHz, climb, hzToNote, lengthForHz, midiToHz, parseNote, parseNoteList } from '../src/core/tuning';

function run(params: Record<string, string>) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', ...params };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
}

describe('notes', () => {
  it('reads note names', () => {
    expect(parseNote('A4')).toBe(69);
    expect(parseNote('C4')).toBe(60);
    expect(parseNote('c#3')).toBe(49);
    expect(parseNote('Bb2')).toBe(46);
    expect(parseNote('H2')).toBeNull();
    expect(parseNoteList('A3, C4  E4 nope')).toEqual([57, 60, 64]);
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(hzToNote(445)).toMatchObject({ name: 'A4', cents: 20 });
  });

  it('climbs a scale through octaves and lays it out', () => {
    expect(climb(48, [0, 4, 7], 5)).toEqual([48, 52, 55, 60, 64]);
    expect(arrange([1, 2, 3, 4, 5], 'down')).toEqual([5, 4, 3, 2, 1]);
    expect(arrange([1, 2, 3, 4, 5], 'middle')).toEqual([4, 2, 1, 3, 5]);
    expect(arrange([1, 2, 3, 4, 5], 'ends')).toEqual([2, 4, 5, 3, 1]);
    expect(arrange([3, 1, 2], 'listed')).toEqual([3, 1, 2]);
  });
});

describe('cantilever pitch', () => {
  it('matches the clamped-free beam formula', () => {
    // 3 mm steel, 100 mm free: f = 0.5596 · t/L² · √(E/12ρ) ≈ 244.6 Hz
    expect(cantileverHz(100, 3, 'steel')).toBeCloseTo(244.6, 0);
    // halving the length quadruples the pitch; doubling the thickness doubles it
    expect(cantileverHz(50, 3, 'steel') / cantileverHz(100, 3, 'steel')).toBeCloseTo(4, 9);
    expect(cantileverHz(100, 6, 'steel') / cantileverHz(100, 3, 'steel')).toBeCloseTo(2, 9);
    expect(cantileverHz(lengthForHz(440, 6, 'corten'), 6, 'corten')).toBeCloseTo(440, 6);
  });
});

describe('tuned plates', () => {
  it('cuts each plate flat at the height for its note, plus the allowance', () => {
    const m = run({ tuneMode: 'scale', tuneRoot: 'C3', tuneScale: 'major', plateCount: '8', thickness: '6', tuneAllowance: '2' });
    const t = m.sliced.tuning!;
    expect(t.map((x) => x!.name)).toEqual(['C3', 'D3', 'E3', 'F3', 'G3', 'A3', 'B3', 'C4']);
    m.sliced.plates.forEach((p, i) => {
      const top = p.parts[0].bbox.maxY;
      expect(top).toBeCloseTo(t[i]!.length * 1.02, 1);
      expect(cantileverHz(t[i]!.length, 6, 'corten')).toBeCloseTo(t[i]!.hz, 6);
    });
    // allowance leaves every plate flat of its note, never sharp
    for (const x of t) expect(x!.cutHz).toBeLessThan(x!.hz);
  });

  it('works round a radial stand and warns when notes are unreadable', () => {
    const m = run({ sliceMode: 'radial', radialCount: '6', tuneMode: 'chord', tuneRoot: 'A2', tuneChord: 'minor' });
    expect(m.sliced.tuning!.map((x) => x!.name)).toEqual(['A2', 'C3', 'E3', 'A3', 'C4', 'E4']);
    const bad = run({ tuneMode: 'notes', tuneNotes: 'la la' });
    expect(bad.sliced.tuning).toBeNull();
    expect(bad.sliced.warnings.some((w) => w.startsWith('Tuning'))).toBe(true);
  });

  it('is off for waffle stacks and leaves strata plates alone', () => {
    expect(run({ sliceMode: 'waffle', tuneMode: 'scale' }).sliced.tuning).toBeNull();
    expect(run({}).sliced.tuning).toBeNull();
  });

  it('every tuned template loads with plates inside the height range and no tuning warnings', () => {
    for (const preset of SOUND_PRESETS.filter((p) => p.params.tuneMode)) {
      const p = applyPreset(newProject(), preset);
      const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
      expect(m.sliced.tuning, preset.name).toBeTruthy();
      expect(m.sliced.tuning!.every((x) => x && !x.clamped), preset.name).toBe(true);
      expect(m.sliced.warnings.filter((w) => w.startsWith('Tuning') || w.includes('overhang')), preset.name).toEqual([]);
      expect(m.issues.filter((i) => i.severity === 'error'), preset.name).toEqual([]);
    }
  });
});
