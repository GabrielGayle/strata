// Turn a spoken phrase into syllables, a speech-like melody, and chant rhythm.
// Manual hyphens in the text override the syllabifier (FREE-PAL-ES-TINE).
import { midiName, parseNote } from './tuning';

export interface Syllable {
  /** Uppercase label etched on the plate (FREE, PAL, …). */
  text: string;
  stressed: boolean;
  /** Long vowel or diphthong — longer note in the rhythm. */
  longVowel: boolean;
  /** Ends in a consonant (coda) — slightly longer hold. */
  closed: boolean;
  /** Vowel nucleus letter for formant lookup (PR B). */
  vowel: string;
}

export interface WordsPhrase {
  syllables: Syllable[];
  midis: number[];
  onsets: number[];
}

const VOWELS = new Set('aeiouy');
const VOWEL_TEAMS: [RegExp, string][] = [
  [/ee|ea|ie|ei/i, 'i'],
  [/oo|ou|ow/i, 'u'],
  [/ai|ay/i, 'a'],
  [/au|aw/i, 'o'],
  [/oi|oy/i, 'o'],
  [/ue|ew/i, 'u'],
];

function nucleusVowel(chunk: string): { vowel: string; long: boolean } {
  const lower = chunk.toLowerCase();
  for (const [re, v] of VOWEL_TEAMS) {
    if (re.test(lower)) return { vowel: v, long: true };
  }
  const m = /[aeiouy]/i.exec(lower);
  if (!m) return { vowel: 'ə', long: false };
  const v = m[0].toLowerCase();
  return { vowel: v === 'y' ? 'i' : v, long: v === 'e' && lower.endsWith('e') && lower.length > 2 };
}

/** Rule-based English syllabifier for one word (letters only). */
export function syllabifyWord(word: string): Syllable[] {
  const w = word.replace(/[^a-zA-Z]/g, '');
  if (!w) return [];
  const lower = w.toLowerCase();
  const chunks: string[] = [];
  let i = 0;
  while (i < lower.length) {
    let chunk = '';
    while (i < lower.length && !VOWELS.has(lower[i])) chunk += w[i++];
    while (i < lower.length && VOWELS.has(lower[i])) chunk += w[i++];
    while (i < lower.length && !VOWELS.has(lower[i])) {
      const nextV = i + 1 < lower.length && VOWELS.has(lower[i + 1]);
      const twoV = i + 2 < lower.length && VOWELS.has(lower[i + 2]);
      if (nextV && !twoV) break;
      chunk += w[i++];
    }
    if (chunk) chunks.push(chunk);
  }
  const out = chunks.map((chunk) => {
    const { vowel, long } = nucleusVowel(chunk);
    const closed = /[bcdfghjklmnpqrstvwxyz]$/i.test(chunk);
    return makeSyl(chunk, vowel, long, closed);
  });
  if (!out.length) out.push(makeSyl(w, 'ə', false, false));
  stressWord(out);
  return out;
}

function makeSyl(text: string, vowel: string, longVowel: boolean, closed = false): Syllable {
  return { text: text.toUpperCase(), stressed: false, longVowel, closed, vowel };
}

function stressWord(syls: Syllable[]) {
  if (syls.length === 1) {
    // Short function syllables (ES, A, THE) stay light; content words take stress.
    syls[0].stressed = syls[0].text.replace(/[^A-Z]/g, '').length > 2;
  } else if (syls.length === 2) syls[0].stressed = true;
  else {
    syls[0].stressed = true;
    if (syls.length > 3) syls[syls.length - 2].stressed = true;
  }
}

/**
 * Split a phrase into syllables. Spaces separate words; hyphens force syllable
 * breaks inside a word (FREE-PAL-ES-TINE).
 */
export function syllabifyPhrase(phrase: string): Syllable[] {
  const raw = phrase.trim();
  if (!raw) return [];
  const out: Syllable[] = [];
  for (const word of raw.split(/\s+/)) {
    if (!word) continue;
    if (word.includes('-')) {
      for (const part of word.split('-')) {
        if (!part) continue;
        const { vowel, long } = nucleusVowel(part);
        const closed = /[bcdfghjklmnpqrstvwxyz]$/i.test(part);
        const syl = makeSyl(part, vowel, long, closed);
        syl.stressed = part.replace(/[^a-zA-Z]/g, '').length > 2;
        out.push(syl);
      }
    } else out.push(...syllabifyWord(word));
  }
  return out;
}

/** Simple speech-melody contour: stress lifts, phrase-final syllable falls home. */
export function melodyMidis(syllables: Syllable[], baseMidi: number): number[] {
  const n = syllables.length;
  if (!n) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push(baseMidi);
    else if (i === n - 1) out.push(baseMidi);
    else if (syllables[i].stressed) out.push(out[i - 1] + 5);
    else out.push(out[i - 1] - 1);
  }
  return out;
}

/** Rhythm weights in eighth-note units at `bpm` (default march tempo 96). */
export function rhythmWeights(syllables: Syllable[]): number[] {
  return syllables.map((s, i) => {
    const last = i === syllables.length - 1;
    let w = s.longVowel ? 2 : 1;
    if (s.closed && !last && s.text.length > 3) w += 0.5;
    if (last) w = 1;
    return w;
  });
}

/** Onset time (seconds) for each syllable from rhythm weights. */
export function chantOnsets(syllables: Syllable[], bpm = 96): number[] {
  const eighth = 60 / bpm / 2;
  const weights = rhythmWeights(syllables);
  const onsets: number[] = [];
  let t = 0;
  for (let i = 0; i < weights.length; i++) {
    onsets.push(t);
    t += weights[i] * eighth;
  }
  return onsets;
}

export function phraseSpec(phrase: string, baseMidi = 67): WordsPhrase {
  const syllables = syllabifyPhrase(phrase);
  return { syllables, midis: melodyMidis(syllables, baseMidi), onsets: chantOnsets(syllables) };
}

/** Parameter patch when the phrase (or melody root) changes — one plate per syllable. */
export function wordsParamPatch(phrase: string, melodyRoot = 'G4'): Record<string, string> {
  const root = parseNote(melodyRoot) ?? 67;
  const spec = phraseSpec(phrase, root);
  const notes = spec.midis.map((m) => midiName(m)).join(' ');
  const labels = spec.syllables.map((s) => s.text).join(' ');
  return {
    tuneWords: phrase,
    plateCount: String(Math.max(1, spec.syllables.length)),
    tuneWordNotes: notes,
    tuneNotes: notes,
    tuneLabels: labels,
    tuneOrder: 'listed',
  };
}

/** Notes for tuning: overrides in tuneWordNotes, else generated melody. */
export function wordsPlateMidis(v: { tuneWords?: string; tuneWordNotes?: string; tuneMelodyRoot?: string }): number[] {
  const root = parseNote(String(v.tuneMelodyRoot ?? 'G4')) ?? 67;
  const spec = phraseSpec(String(v.tuneWords ?? ''), root);
  const overrides = String(v.tuneWordNotes ?? '')
    .trim()
    .split(/[\s,;]+/)
    .map((s) => parseNote(s))
    .filter((n): n is number => n !== null);
  if (!spec.syllables.length) return [];
  return spec.syllables.map((_, i) => overrides[i] ?? spec.midis[i]);
}

export function wordsLabels(v: { tuneWords?: string }): string[] {
  return syllabifyPhrase(String(v.tuneWords ?? '')).map((s) => s.text);
}

export function wordsOnsets(v: { tuneWords?: string }): number[] {
  return chantOnsets(syllabifyPhrase(String(v.tuneWords ?? '')));
}

/** Canonical chant rhythm for the Free Palestine syllables (96 bpm). */
export const FREE_PALESTINE_ONSETS = [0, 0.625, 0.9375, 1.25];
