// Map vowel formants to tunable plate frequencies for speech-like clusters.
//
// Formant frequencies (Hz) for American English vowels, averaged across talkers.
// G. E. Peterson & H. L. Barney (1952), J. Acoust. Soc. Am. 24, 175–184.
import { syllabifyPhrase, wordsParamPatch, wordsPlateMidis, type Syllable } from './chantWords';
import { MAX_TUNED, MIN_TUNED, lengthForHz, midiToHz } from './tuning';

export interface VowelFormants {
  f1: number;
  f2: number;
  f3: number;
}

/** Peterson & Barney (1952) — see file header. */
export const PETERSON_BARNEY: Record<string, VowelFormants> = {
  a: { f1: 730, f2: 1090, f3: 2440 },
  e: { f1: 530, f2: 1840, f3: 2480 },
  i: { f1: 270, f2: 2290, f3: 3010 },
  o: { f1: 570, f2: 840, f3: 2410 },
  u: { f1: 300, f2: 870, f3: 2240 },
  ə: { f1: 500, f2: 1500, f3: 2500 },
};

export function vowelFormants(vowel: string): VowelFormants {
  return PETERSON_BARNEY[vowel] ?? PETERSON_BARNEY.ə;
}

/** Shift by octaves until the plate length at `thickness` sits in the tuner range. */
export function formantPlateMidi(hz: number, thicknessMm: number, material: string): { midi: number; clamped: boolean } {
  const rawMidi = 69 + 12 * Math.log2(hz / 440);
  for (let k = -6; k <= 6; k++) {
    const m = Math.round(rawMidi + 12 * k);
    const len = lengthForHz(midiToHz(m), thicknessMm, material);
    if (len >= MIN_TUNED && len <= MAX_TUNED) return { midi: m, clamped: false };
  }
  const m = Math.round(rawMidi);
  const len = lengthForHz(midiToHz(m), thicknessMm, material);
  return { midi: m, clamped: len < MIN_TUNED || len > MAX_TUNED };
}

export function speechPlatesPerSyllable(v: { tuneSpeechPlates?: string | number }): number {
  const n = Math.round(Number(v.tuneSpeechPlates) || 2);
  return Math.min(3, Math.max(1, n));
}

export function speechHasFundamental(v: { tuneSpeechFundamental?: boolean | string }): boolean {
  const x = v.tuneSpeechFundamental;
  return x === true || x === 'true' || x === 'on';
}

/** Plates needed: syllables × (formant plates + optional melody plate). */
export function speechPlateCount(v: { tuneWords?: string; tuneSpeechPlates?: string; tuneSpeechFundamental?: boolean | string }): number {
  const n = syllabifyPhrase(String(v.tuneWords ?? '')).length;
  if (!n) return 0;
  const per = speechPlatesPerSyllable(v);
  const fund = speechHasFundamental(v);
  return n * (per + (fund ? 1 : 0));
}

export function speechPlateMidis(
  v: { tuneWords?: string; tuneWordNotes?: string; tuneMelodyRoot?: string; tuneSpeechPlates?: string; tuneSpeechFundamental?: boolean | string; thickness?: number; plateMaterial?: string },
  count: number,
): number[] {
  const syls = syllabifyPhrase(String(v.tuneWords ?? ''));
  if (!syls.length) return [];
  const per = speechPlatesPerSyllable(v);
  const fund = speechHasFundamental(v);
  const melody = wordsPlateMidis(v);
  const thickness = Number(v.thickness) || 3;
  const material = String(v.plateMaterial ?? 'steel');
  const out: number[] = [];
  for (let i = 0; i < syls.length; i++) {
    if (fund) out.push(melody[i] ?? melody[0]);
    const f = vowelFormants(syls[i].vowel);
    const hzList = [f.f1, f.f2, f.f3].slice(0, per);
    for (const hz of hzList) out.push(formantPlateMidi(hz, thickness, material).midi);
  }
  if (count > out.length) return Array.from({ length: count }, (_, i) => out[i % out.length]);
  return out.slice(0, count);
}

/** Etch labels: syllable + role (melody note or F1/F2/F3). */
export function speechLabels(v: { tuneWords?: string; tuneWordNotes?: string; tuneMelodyRoot?: string; tuneSpeechPlates?: string; tuneSpeechFundamental?: boolean | string }): string[] {
  const syls = syllabifyPhrase(String(v.tuneWords ?? ''));
  const per = speechPlatesPerSyllable(v);
  const fund = speechHasFundamental(v);
  const tags = ['F1', 'F2', 'F3'];
  const out: string[] = [];
  for (let i = 0; i < syls.length; i++) {
    if (fund) out.push(`${syls[i].text} M`);
    for (let k = 0; k < per; k++) out.push(`${syls[i].text} ${tags[k]}`);
  }
  return out;
}

export function speechParamPatch(
  phrase: string,
  melodyRoot = 'G4',
  platesPer = '2',
  fundamental = true,
): Record<string, string | boolean> {
  const base = wordsParamPatch(phrase, melodyRoot);
  const params = { tuneWords: phrase, tuneSpeechPlates: platesPer, tuneSpeechFundamental: fundamental };
  return {
    ...base,
    tuneSpeechPlates: platesPer,
    tuneSpeechFundamental: fundamental,
    plateCount: String(speechPlateCount(params)),
  };
}

export function formantHzForSyllable(syl: Syllable, index: number): number {
  const f = vowelFormants(syl.vowel);
  return [f.f1, f.f2, f.f3][index] ?? f.f1;
}
