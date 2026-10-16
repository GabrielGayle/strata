// Browser-side audio: read a sound file into mono samples, and play samples or a
// struck-plate tone through the speakers. The pure maths lives in core/sound.ts.
import { synth, type Audio, type SoundSpec } from '../core/sound';
import { grayDataUrl } from './surfaces';
import { renderSound, soundSize } from '../core/sound';
import { OVERTONE_RATIO } from '../core/tuning';
import { CHANT_ONSETS } from '../core/soundPresets';

const MAX_RATE = 16000;
const MAX_SECONDS = 120;

/** Recordings loaded this session, by file name, so a sound picture can be re-edited without reloading. */
const loaded = new Map<string, Audio>();
export const loadedAudio = (name?: string) => (name ? loaded.get(name) ?? null : null);

let ctx: AudioContext | null = null;
const audioCtx = () => (ctx ??= new AudioContext());

/** Ask for a sound file and decode it to mono at up to 16 kHz (box-averaged down). */
export function readAudio(): Promise<{ name: string; audio: Audio } | null> {
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*,.wav,.mp3,.m4a,.ogg,.flac';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      try {
        const buf = await audioCtx().decodeAudioData(await f.arrayBuffer());
        const k = Math.max(1, Math.ceil(buf.sampleRate / MAX_RATE));
        const n = Math.min(Math.floor(buf.length / k), Math.floor((MAX_SECONDS * buf.sampleRate) / k));
        const data = new Float32Array(n);
        const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (const ch of chans) for (let j = 0; j < k; j++) s += ch[i * k + j];
          data[i] = s / (k * chans.length);
        }
        const audio = { rate: buf.sampleRate / k, data };
        loaded.set(f.name, audio);
        resolve({ name: f.name, audio });
      } catch (e) {
        reject(e);
      }
    };
    inp.click();
  });
}

let playing: AudioBufferSourceNode | null = null;

export function stopAudio() {
  try {
    playing?.stop();
  } catch {
    /* already stopped */
  }
  playing = null;
}

export function playAudio(a: Audio, gain = 0.3) {
  stopAudio();
  const ac = audioCtx();
  const buf = ac.createBuffer(1, a.data.length, a.rate);
  buf.copyToChannel(a.data as Float32Array<ArrayBuffer>, 0);
  const src = ac.createBufferSource();
  const g = ac.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(g).connect(ac.destination);
  src.start();
  playing = src;
}

/**
 * Roughly what a struck cantilever plate sounds like: the fundamental with a
 * long decay plus the inharmonic second mode (6.27×) dying away quickly.
 */
export function playStrike(hz: number, seconds = 2.5) {
  const rate = 22050;
  const n = Math.round(seconds * rate);
  const data = new Float32Array(n);
  const f2 = hz * OVERTONE_RATIO;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.003);
    data[i] = attack * (Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 1.6) + (f2 < rate / 2 ? 0.35 * Math.sin(2 * Math.PI * f2 * t) * Math.exp(-t * 9) : 0));
  }
  playAudio({ rate, data }, 0.35);
}

const PARTIAL_AMP = [1, 0.28, 0.14];
const PARTIAL_DECAY = [1.5, 4.2, 7.5];

/** One struck free-free plate: f1, f2 and f3 as decaying sines. */
export function strikeSamples(partials: number[], seconds: number, rate = 22050): Float32Array {
  const n = Math.round(seconds * rate);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.004);
    let s = 0;
    for (let k = 0; k < partials.length && k < 3; k++) {
      const f = partials[k];
      if (f > 20 && f < rate / 2) s += PARTIAL_AMP[k] * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * PARTIAL_DECAY[k]);
    }
    data[i] = attack * s;
  }
  return data;
}

export function playModes(partials: number[], seconds = 2.2) {
  const rate = 22050;
  const data = strikeSamples(partials, seconds, rate);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak;
  playAudio({ rate, data }, 0.4);
}

/**
 * Plates in order, each entering on the chant rhythm (quarter, eighth, eighth,
 * dotted quarter when there are four). Decays overlap, the way a call does.
 */
/** Several plate fundamentals struck together (speech-like vowel cluster). */
export function playCluster(hzs: number[], seconds = 1.6) {
  const rate = 22050;
  const n = Math.round(seconds * rate);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.004);
    let s = 0;
    for (const hz of hzs) {
      if (hz > 20 && hz < rate / 2) s += Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 2.2);
    }
    data[i] = attack * s;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < n; i++) data[i] /= peak;
  playAudio({ rate, data }, 0.42);
}

export function playChant(partials: number[][], onsets: number[] = CHANT_ONSETS) {
  const rate = 22050;
  const tail = 2.4;
  const at = partials.map((_, i) => (i < onsets.length ? onsets[i] : onsets[onsets.length - 1] + (i - onsets.length + 1) * 0.5));
  const n = Math.max(1, Math.round(((at[at.length - 1] ?? 0) + tail) * rate));
  const data = new Float32Array(n);
  partials.forEach((p, i) => {
    const start = Math.round(at[i] * rate);
    const hit = strikeSamples(p, tail, rate);
    for (let j = 0; j < hit.length && start + j < n; j++) data[start + j] += hit[j];
  });
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < n; i++) data[i] /= peak;
  playAudio({ rate, data }, 0.45);
}

/** The audio behind a spec: the tone it describes, or the file loaded this session. */
export function audioFor(spec: SoundSpec): Audio | null {
  return spec.source === 'tone' ? synth(spec) : loadedAudio(spec.fileName);
}

/** PNG of a sound picture, stored in the project like an uploaded image. */
export function soundDataUrl(spec: SoundSpec, audio: Audio | null = audioFor(spec), long = 512): string | null {
  if (!audio) return null;
  const { w, h } = soundSize(spec, long);
  return grayDataUrl(renderSound(audio, spec, w, h));
}
