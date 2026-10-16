import { describe, expect, it } from 'vitest';
import { syllabifyPhrase } from '../src/core/chantWords';
import {
  formantPlateMidi,
  PETERSON_BARNEY,
  speechPlateCount,
  speechPlateMidis,
  speechPlatesPerSyllable,
  vowelFormants,
} from '../src/core/speechTuning';
import { MAX_TUNED, MIN_TUNED, lengthForHz, midiToHz } from '../src/core/tuning';

describe('vowel formants', () => {
  it('uses Peterson & Barney (1952) values', () => {
    expect(PETERSON_BARNEY.i.f1).toBe(270);
    expect(vowelFormants('a').f2).toBe(1090);
  });

  it('maps formants into the playable length range', () => {
    const { midi, clamped } = formantPlateMidi(2290, 3, 'steel');
    const len = lengthForHz(midiToHz(midi), 3, 'steel');
    expect(clamped).toBe(false);
    expect(len).toBeGreaterThanOrEqual(MIN_TUNED);
    expect(len).toBeLessThanOrEqual(MAX_TUNED);
  });
});

describe('speech plate counts', () => {
  const phrase = 'FREE-PAL-ES-TINE';
  const syls = syllabifyPhrase(phrase).length;

  it('counts plates from syllables × (formants + optional melody)', () => {
    expect(syls).toBe(4);
    expect(speechPlateCount({ tuneWords: phrase, tuneSpeechPlates: '2', tuneSpeechFundamental: true })).toBe(4 * 3);
    expect(speechPlateCount({ tuneWords: phrase, tuneSpeechPlates: '1', tuneSpeechFundamental: false })).toBe(4);
    expect(speechPlatesPerSyllable({ tuneSpeechPlates: '3' })).toBe(3);
  });

  it('emits one midi per plate in speech order', () => {
    const midis = speechPlateMidis(
      { tuneWords: phrase, tuneMelodyRoot: 'G4', tuneSpeechPlates: '2', tuneSpeechFundamental: true, thickness: 3, plateMaterial: 'steel' },
      12,
    );
    expect(midis).toHaveLength(12);
  });
});
