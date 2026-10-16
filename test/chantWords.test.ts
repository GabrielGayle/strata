import { describe, expect, it } from 'vitest';
import { chantOnsets, melodyMidis, phraseSpec, syllabifyPhrase, syllabifyWord, wordsPlateMidis } from '../src/core/chantWords';
import { midiName, parseNote } from '../src/core/tuning';
import { createPipeline } from '../src/core/pipeline';
import { applyPreset, newProject } from '../src/core/project';
import { SOUND_PRESETS } from '../src/core/soundPresets';

describe('syllabifier', () => {
  it('splits English words on vowel nuclei', () => {
    expect(syllabifyWord('hello').map((s) => s.text)).toEqual(['HEL', 'LO']);
    expect(syllabifyWord('water').map((s) => s.text)).toEqual(['WA', 'TER']);
  });

  it('honours manual hyphens', () => {
    expect(syllabifyPhrase('FREE-PAL-ES-TINE').map((s) => s.text)).toEqual(['FREE', 'PAL', 'ES', 'TINE']);
    expect(syllabifyPhrase('hel-lo').map((s) => s.text)).toEqual(['HEL', 'LO']);
  });
});

describe('speech melody', () => {
  it('lands Free Palestine on G4 C5 B4 G4', () => {
    const syls = syllabifyPhrase('FREE-PAL-ES-TINE');
    const midis = melodyMidis(syls, parseNote('G4')!);
    expect(midis.map((m) => midiName(m))).toEqual(['G4', 'C5', 'B4', 'G4']);
  });

  it('reads overrides from tuneWordNotes', () => {
    const midis = wordsPlateMidis({ tuneWords: 'FREE-PAL-ES-TINE', tuneMelodyRoot: 'G4', tuneWordNotes: 'A3 B3 C4 D4' });
    expect(midis.map((m) => midiName(m))).toEqual(['A3', 'B3', 'C4', 'D4']);
  });
});

describe('chant rhythm', () => {
  it('matches the Free Palestine march at 96 bpm', () => {
    const onsets = chantOnsets(syllabifyPhrase('FREE-PAL-ES-TINE'), 96);
    expect(onsets[0]).toBeCloseTo(0, 6);
    expect(onsets[1]).toBeCloseTo(0.625, 6);
    expect(onsets[2]).toBeCloseTo(0.9375, 6);
    expect(onsets[3]).toBeCloseTo(1.25, 6);
  });

  it('gives longer slots to long vowels than to short ones', () => {
    const spec = phraseSpec('FREE-PAL-ES-TINE');
    const gaps = spec.onsets.slice(1).map((t, i) => t - spec.onsets[i]);
    expect(gaps[0]).toBeGreaterThan(gaps[1]);
    expect(spec.syllables[0].longVowel).toBe(true);
    expect(spec.syllables[1].longVowel).toBe(false);
  });
});

describe('Free Palestine preset', () => {
  it('still cuts G4 C5 B4 G4 with etched syllables', () => {
    const preset = SOUND_PRESETS.find((p) => p.name === 'Free Palestine');
    const p = applyPreset(newProject(), preset!);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
    expect(m.sliced.tuning!.map((x) => x!.name)).toEqual(['G4', 'C5', 'B4', 'G4']);
    expect(m.sliced.tuning!.map((x) => x!.label)).toEqual(['FREE G4', 'PAL C5', 'ES B4', 'TINE G4']);
  });
});
