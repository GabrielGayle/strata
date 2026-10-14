// Sound → greyscale. A tone, a chord or a loaded recording is turned into the
// same brightness grid an uploaded picture becomes, so it can drive the side
// profile, the top impression or the front cut-outs. Pure, so it can be tested.
import type { Gray } from './image';
import { midiToHz, parseNoteList } from './tuning';

export type Wave = 'sine' | 'triangle' | 'saw' | 'square';
/**
 * bars: loudness over time (the classic sound-wave sculpture, one bar per plate);
 * wave: the waveform itself, so plate heights trace the oscillation;
 * spectrum: time across, pitch up the picture, brightness = how loud each pitch is.
 */
export type SoundView = 'bars' | 'wave' | 'spectrum';

export interface SoundSpec {
  source: 'tone' | 'file';
  /** Tone: note names played together, like "A3 C#4 E4". */
  notes: string;
  wave: Wave;
  /** Tone length in seconds. */
  seconds: number;
  /** Tremolo / beat: a second voice detuned by this many Hz makes the loudness pulse. */
  beat: number;
  /** Pitch glide over the whole length, in semitones (+ slides up). */
  glide?: number;
  /** 0..1 fade in, 0..1 fade out (fractions of the length). */
  attack: number;
  release: number;
  view: SoundView;
  /** Wave view: how many cycles of the lowest note fit across the picture. */
  cycles: number;
  /**
   * Draw the sound as a picture: dark marks on white, a mirrored waveform for
   * bars and wave, so it presses into the top or cuts through the front.
   * Off, brightness is the level itself (for the side profile's heights).
   */
  drawn: boolean;
  /** Box smoothing over time, as a fraction of the picture width. */
  smooth: number;
  /** Width / height of the stored picture. */
  aspect: number;
  /** File: the loaded file's name (the audio itself isn't kept in the project). */
  fileName?: string;
}

export const DEFAULT_SOUND: SoundSpec = {
  source: 'tone',
  notes: 'A3 C#4 E4',
  wave: 'sine',
  seconds: 2,
  beat: 1.5,
  attack: 0.05,
  release: 0.6,
  view: 'bars',
  cycles: 3,
  drawn: false,
  smooth: 0.01,
  aspect: 2,
};

export interface Audio {
  rate: number;
  data: Float32Array;
}

function osc(wave: Wave, ph: number): number {
  const x = ph - Math.floor(ph);
  switch (wave) {
    case 'square':
      return x < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * x - 1;
    case 'triangle':
      return 1 - 4 * Math.abs(x - 0.5);
    default:
      return Math.sin(2 * Math.PI * x);
  }
}

/** Render the spec's tone (all its notes at once) to mono samples in -1..1. */
export function synth(spec: SoundSpec, rate = 8000): Audio {
  const hz = parseNoteList(spec.notes).map(midiToHz);
  const n = Math.max(16, Math.round(Math.max(0.05, spec.seconds) * rate));
  const data = new Float32Array(n);
  if (!hz.length) return { rate, data };
  const a = Math.max(1, spec.attack * n);
  const r = Math.max(1, spec.release * n);
  let peak = 0;
  // phase of each voice, integrated so a glide stays continuous
  const ph = new Float64Array(hz.length * 2);
  const glide = spec.glide ?? 0;
  for (let i = 0; i < n; i++) {
    const bend = 2 ** ((glide * i) / n / 12);
    let s = 0;
    hz.forEach((f, k) => {
      ph[2 * k] += (f * bend) / rate;
      s += osc(spec.wave, ph[2 * k]);
      if (spec.beat > 0) {
        ph[2 * k + 1] += (f * bend + spec.beat) / rate;
        s += osc(spec.wave, ph[2 * k + 1]);
      }
    });
    const env = Math.min(1, i / a, (n - i) / r);
    data[i] = s * env;
    peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak > 0) for (let i = 0; i < n; i++) data[i] /= peak;
  return { rate, data };
}

/** Lowest note of a tone spec in Hz (for the wave view's time window). */
export function lowestHz(spec: SoundSpec): number | null {
  const hz = parseNoteList(spec.notes).map(midiToHz);
  return hz.length ? Math.min(...hz) : null;
}

function smoothRow(row: Float32Array, r: number): Float32Array {
  if (r < 1) return row;
  const out = new Float32Array(row.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? out.slice() : row;
    let acc = 0;
    const n = row.length;
    const at = (i: number) => src[Math.min(n - 1, Math.max(0, i))];
    for (let i = -r; i <= r; i++) acc += at(i);
    for (let i = 0; i < n; i++) {
      out[i] = acc / (2 * r + 1);
      acc += at(i + r + 1) - at(i - r);
    }
  }
  return out;
}

/** Peak loudness 0..1 in `w` slices of the audio. */
export function envelope(audio: Audio, w: number): Float32Array {
  const out = new Float32Array(w);
  const n = audio.data.length;
  let peak = 0;
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x * n) / w);
    const b = Math.max(a + 1, Math.floor(((x + 1) * n) / w));
    let m = 0;
    for (let i = a; i < b && i < n; i++) m = Math.max(m, Math.abs(audio.data[i]));
    out[x] = m;
    peak = Math.max(peak, m);
  }
  if (peak > 0) for (let x = 0; x < w; x++) out[x] /= peak;
  return out;
}

/** In-place radix-2 FFT (length must be a power of two). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
  }
}

/**
 * Spectrogram: `w` time slices by `h` pitch rows on a log-frequency axis from
 * `lo` to `hi` Hz (row 0 = highest). Brightness = level in dB over a 50 dB range.
 */
export function spectrogram(audio: Audio, w: number, h: number, lo = 55, hi = 2000): Float32Array {
  const N = 2048;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const out = new Float32Array(w * h);
  const n = audio.data.length;
  const top = Math.min(hi, audio.rate / 2);
  let max = -Infinity;
  const db = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    const c = Math.floor(((x + 0.5) * n) / w);
    for (let i = 0; i < N; i++) {
      const j = c - N / 2 + i;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = j >= 0 && j < n ? audio.data[j] * hann : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < h; y++) {
      const f = lo * (top / lo) ** (1 - (y + 0.5) / h);
      const bin = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / audio.rate)));
      const m = Math.hypot(re[bin], im[bin]);
      const d = 20 * Math.log10(m + 1e-9);
      db[y * w + x] = d;
      max = Math.max(max, d);
    }
  }
  for (let i = 0; i < w * h; i++) out[i] = Math.min(1, Math.max(0, (db[i] - (max - 50)) / 50));
  return out;
}

/**
 * The sound as a brightness grid (white = high / proud). In the side profile
 * each image column becomes one plate, so a bars picture gives each plate the
 * loudness of its slice of the sound.
 */
export function renderSound(audio: Audio, spec: SoundSpec, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  const r = Math.round(spec.smooth * w);
  if (spec.view === 'spectrum') {
    const g = spectrogram(audio, w, h);
    for (let y = 0; y < h; y++) data.set(smoothRow(g.subarray(y * w, (y + 1) * w), r), y * w);
    return { w, h, data };
  }
  let row: Float32Array;
  if (spec.view === 'wave') {
    // a short window from the middle of the sound, `cycles` of the lowest note wide
    const f = spec.source === 'tone' ? lowestHz(spec) : null;
    const span = Math.min(audio.data.length, f ? Math.round((spec.cycles / f) * audio.rate) : audio.data.length);
    const start = Math.max(0, Math.floor((audio.data.length - span) / 2));
    row = new Float32Array(w);
    let peak = 0;
    for (let x = 0; x < w; x++) {
      const s = audio.data[Math.min(audio.data.length - 1, start + Math.floor(((x + 0.5) * span) / w))] ?? 0;
      row[x] = s;
      peak = Math.max(peak, Math.abs(s));
    }
    for (let x = 0; x < w; x++) row[x] = 0.5 + 0.5 * (peak > 0 ? row[x] / peak : 0);
  } else {
    row = envelope(audio, w);
  }
  row = smoothRow(row, r);
  for (let y = 0; y < h; y++) {
    const yy = 1 - (y + 0.5) / h; // 0 at the bottom, 1 at the top
    for (let x = 0; x < w; x++) {
      let b = row[x];
      if (spec.drawn) {
        // bars: a mirrored filled waveform about the middle; wave: a line tracing the oscillation
        const inside = spec.view === 'bars' ? Math.abs(yy - 0.5) * 2 <= row[x] * 0.96 : nearLine(yy, row, x);
        b = inside ? 0 : 1;
      }
      data[y * w + x] = b;
    }
  }
  return { w, h, data };
}

/** Wave line drawing: within a stroke of the trace, joining each column to the next so steep slopes stay solid. */
function nearLine(yy: number, row: Float32Array, x: number): boolean {
  const at = (i: number) => 0.06 + row[Math.min(row.length - 1, Math.max(0, i))] * 0.88;
  const a = at(x), b = at(x + 1), c = at(x - 1);
  const lo = Math.min(a, (a + b) / 2, (a + c) / 2) - 0.04;
  const hi = Math.max(a, (a + b) / 2, (a + c) / 2) + 0.04;
  return yy >= lo && yy <= hi;
}

/** Picture size for a spec, `long` pixels on the long side. */
export function soundSize(spec: SoundSpec, long = 512): { w: number; h: number } {
  const a = Math.max(0.1, spec.aspect);
  return a >= 1 ? { w: long, h: Math.max(8, Math.round(long / a)) } : { w: Math.max(8, Math.round(long * a)), h: long };
}
