// Tuned plates. Two models:
//
// Cantilever — the plate stands in the concrete like a tuning-fork tine, and
// its free height above the base sets the note.
//
// Free — a sounding plate, hung at the nodes like a xylophone bar. Length is
// chosen so the free-free fundamental (src/core/beam.ts) is the note.
//
// Model: an Euler–Bernoulli cantilever, rigidly clamped at the concrete and
// free at the top, bending through its thickness. The first mode is
//   f1 = (β1² / 2π) · (t / L²) · √(E / 12ρ),  β1 = 1.8751
// so f1 does not depend on the plate's width, and L = √(β1²/2π · t · c / f).
// Real plates ring somewhat off this (the concrete clamp gives a little, wide
// plates stiffen like a plate rather than a beam, cut-outs change the mass),
// so plates are cut a little long and trimmed down to pitch with a tuner.
import type { Values } from './params';
import { tuneBar, beamModes } from './beam';
import { wordsLabels, wordsPlateMidis } from './chantWords';

/** Young's modulus (Pa) and density (kg/m³) of the plate materials. */
export const MATERIALS: Record<string, { E: number; rho: number; label: string }> = {
  steel: { E: 200e9, rho: 7850, label: 'mild steel' },
  corten: { E: 200e9, rho: 7850, label: 'Corten' },
  aluminium: { E: 69e9, rho: 2700, label: 'aluminium' },
};

const BETA1 = 1.8751;
const K1 = (BETA1 * BETA1) / (2 * Math.PI);
/** Second cantilever mode over the first: the clangy, inharmonic overtone. */
export const OVERTONE_RATIO = (4.6941 / BETA1) ** 2;

function bendingSpeed(material: string): number {
  const m = MATERIALS[material] ?? MATERIALS.steel;
  return Math.sqrt(m.E / (12 * m.rho)); // m/s
}

/** First-mode frequency (Hz) of a plate with free length `lengthMm` and thickness `thicknessMm`. */
export function cantileverHz(lengthMm: number, thicknessMm: number, material: string): number {
  const L = lengthMm / 1000;
  const t = thicknessMm / 1000;
  return (K1 * t * bendingSpeed(material)) / (L * L);
}

/** Free length (mm) above the clamp that rings at `hz`. */
export function lengthForHz(hz: number, thicknessMm: number, material: string): number {
  const t = thicknessMm / 1000;
  return Math.sqrt((K1 * t * bendingSpeed(material)) / hz) * 1000;
}

// ---------------------------------------------------------------------------
// Notes

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI number of a note name like "A4", "C#3", "Bb2" (null if it isn't one). */
export function parseNote(s: string): number | null {
  const m = /^\s*([A-Ga-g])([#♯b♭]?)(-?\d)\s*$/.exec(s);
  if (!m) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + PC[m[1].toUpperCase()] + acc;
}

export const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export function midiName(midi: number): string {
  const n = Math.round(midi);
  return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Nearest note and how far off it is, in cents (+ = sharp). */
export function hzToNote(hz: number): { midi: number; name: string; cents: number } {
  const m = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(m);
  return { midi, name: midiName(midi), cents: Math.round((m - midi) * 100) };
}

/** Space- or comma-separated note names; anything unreadable is skipped. */
export function parseNoteList(s: string): number[] {
  return String(s)
    .split(/[\s,;]+/)
    .map(parseNote)
    .filter((n): n is number => n !== null);
}

export const SCALES: Record<string, { label: string; steps: number[] }> = {
  major: { label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Natural minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  pentaMajor: { label: 'Pentatonic major', steps: [0, 2, 4, 7, 9] },
  pentaMinor: { label: 'Pentatonic minor', steps: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  wholeTone: { label: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
  chromatic: { label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const CHORDS: Record<string, { label: string; steps: number[] }> = {
  major: { label: 'Major', steps: [0, 4, 7] },
  minor: { label: 'Minor', steps: [0, 3, 7] },
  maj7: { label: 'Major 7th', steps: [0, 4, 7, 11] },
  min7: { label: 'Minor 7th', steps: [0, 3, 7, 10] },
  dom7: { label: 'Dominant 7th', steps: [0, 4, 7, 10] },
  sus2: { label: 'Sus 2', steps: [0, 2, 7] },
  sus4: { label: 'Sus 4', steps: [0, 5, 7] },
  dim: { label: 'Diminished', steps: [0, 3, 6] },
  aug: { label: 'Augmented', steps: [0, 4, 8] },
};

const opts = (r: Record<string, { label: string }>) => Object.entries(r).map(([value, { label }]) => ({ value, label }));
export const SCALE_OPTIONS = opts(SCALES);
export const CHORD_OPTIONS = opts(CHORDS);

/** MIDI choices for per-plate note dropdowns (C2–C6). */
export const NOTE_CHOICES = Array.from({ length: 49 }, (_, i) => {
  const midi = 36 + i;
  return { value: midi, label: midiName(midi) };
});

/** `count` notes climbing a scale or chord from `root`, octave after octave. */
export function climb(root: number, steps: number[], count: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(root + 12 * Math.floor(k / steps.length) + steps[k % steps.length]);
  return out;
}

/**
 * Lay notes out over the plates. 'up' and 'down' run front to back (or round
 * the ring); 'middle' puts the lowest, tallest plate in the centre and climbs
 * outwards; 'ends' does the opposite, tallest at both ends; 'listed' keeps
 * the order given (custom notes repeat in the order typed).
 */
export function arrange(notes: number[], order: string): number[] {
  const asc = [...notes].sort((a, b) => a - b);
  if (order === 'down') return asc.reverse();
  if (order === 'middle' || order === 'ends') {
    const seq = order === 'middle' ? asc : asc.reverse();
    const n = seq.length;
    const out = new Array<number>(n);
    const mid = (n - 1) / 2;
    // fill the slots nearest the centre first, alternating sides
    const slots = [...Array(n).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    slots.forEach((s, i) => (out[s] = seq[i]));
    return out;
  }
  if (order === 'listed') return notes;
  return asc;
}

export function tuningActive(v: Values): boolean {
  return v.tuneMode !== 'off' && v.stackSource === 'strata' && (v.sliceMode === 'parallel' || v.sliceMode === 'radial');
}

/** Target notes, one per plate, in plate order. Empty when the settings don't name any. */
export function plateNotes(v: Values, count: number): number[] {
  if (count <= 0) return [];
  let notes: number[];
  if (v.tuneMode === 'words') {
    notes = wordsPlateMidis(v);
    if (!notes.length) return [];
    if (count > notes.length) notes = Array.from({ length: count }, (_, i) => notes[i % notes.length]);
    else if (count < notes.length) notes = notes.slice(0, count);
  } else if (v.tuneMode === 'notes') {
    const list = parseNoteList(v.tuneNotes);
    if (!list.length) return [];
    notes = Array.from({ length: count }, (_, i) => list[i % list.length]);
  } else {
    const root = parseNote(v.tuneRoot);
    if (root === null) return [];
    const set = v.tuneMode === 'chord' ? CHORDS[v.tuneChord] ?? CHORDS.major : SCALES[v.tuneScale] ?? SCALES.major;
    notes = climb(root, set.steps, count);
  }
  return arrange(notes, v.tuneMode === 'words' ? 'listed' : v.tuneOrder);
}

export interface PlateTune {
  /** Target note (MIDI) and its frequency. */
  midi: number;
  name: string;
  hz: number;
  /** Free length above the concrete that rings at the target, mm. */
  length: number;
  /** Free length actually cut: the target length plus the tuning allowance. */
  cut: number;
  /** Predicted ring of the plate as cut (before trimming). */
  cutHz: number;
  /** Metal the plate is cut from (aluminium needs a different length than steel for the same note). */
  material: string;
  /** The length was held to MIN_TUNED…MAX_TUNED, so the plate won't reach its note. */
  clamped: boolean;
  /** Cantilever tine, or a free-free bar hung at its nodes. */
  model?: 'cantilever' | 'free';
  /** f1..f3 of the plate as cut. Set for free-free bars. */
  partials?: number[];
  /** Nodes of the first mode, fractions of the bar length from the low end. */
  nodes?: number[];
  /** Etched on the plate, e.g. "FREE G4". */
  label?: string;
}

export const MIN_TUNED = 10;
export const MAX_TUNED = 2500;

const splitLabels = (s: unknown) =>
  String(s ?? '')
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);

/** Per-plate target notes and free lengths for `count` plates, or null when the notes can't be read. */
export function tunePlates(v: Values, count: number, materials?: string[], widths?: number[]): PlateTune[] | null {
  const notes = plateNotes(v, count);
  if (!notes.length) return null;
  const allow = 1 + Math.max(0, v.tuneAllowance) / 100;
  const free = v.tuneModel === 'free';
  const labels = v.tuneMode === 'words' ? wordsLabels(v) : splitLabels(v.tuneLabels);
  return notes.map((midi, i) => {
    const material = materials?.[i] ?? String(v.plateMaterial);
    const name = midiName(midi);
    const hz = midiToHz(midi);
    const word = labels[i];
    const label = word ? `${word} ${name}` : free ? name : undefined;
    if (!free) {
      const length = lengthForHz(hz, v.thickness, material);
      const want = length * allow;
      const cut = Math.min(MAX_TUNED, Math.max(MIN_TUNED, want));
      return { midi, name, hz, length, cut, cutHz: cantileverHz(cut, v.thickness, material), material, clamped: cut !== want, model: 'cantilever' as const, label };
    }
    const width = widths?.[i] && widths[i] > 1 ? widths[i] : Number(v.plateWidth) || 40;
    const holeR = Math.max(0, Number(v.tuneHole) || 0) / 2;
    const tuned = tuneBar({ targetHz: hz, thicknessMm: v.thickness, widthMm: width, material, holeRmm: holeR });
    const want = tuned.lengthMm * allow;
    const cut = Math.min(MAX_TUNED, Math.max(MIN_TUNED, want));
    const atCut =
      Math.abs(cut - tuned.lengthMm) < 1e-6
        ? tuned
        : beamModes({ lengthMm: cut, thicknessMm: v.thickness, widthMm: width, material, holeRmm: holeR, holeAt: tuned.nodes });
    return {
      midi, name, hz, length: tuned.lengthMm, cut, cutHz: atCut.hz[0], material, clamped: Math.abs(cut - want) > 1e-6,
      model: 'free' as const, partials: atCut.hz, nodes: atCut.nodes, label,
    };
  });
}
