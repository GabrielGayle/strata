import { describe, expect, it } from 'vitest';
import { DEFAULT_SOUND, envelope, renderSound, soundSize, spectrogram, synth, type SoundSpec } from '../src/core/sound';

const spec = (p: Partial<SoundSpec>): SoundSpec => ({ ...DEFAULT_SOUND, ...p });

describe('sound pictures', () => {
  it('synthesises a normalised tone', () => {
    const a = synth(spec({ notes: 'A4', beat: 0, seconds: 1 }));
    expect(a.data.length).toBe(8000);
    expect(Math.max(...a.data.map(Math.abs))).toBeCloseTo(1, 6);
    expect(synth(spec({ notes: '' })).data.every((x) => x === 0)).toBe(true);
  });

  it('loudness follows fades and beats', () => {
    const a = synth(spec({ notes: 'A3', beat: 0, attack: 0.5, release: 0.01, seconds: 1 }));
    const env = envelope(a, 10);
    for (let i = 1; i < 5; i++) expect(env[i]).toBeGreaterThan(env[i - 1]);
    const beat = envelope(synth(spec({ notes: 'A3', beat: 2, attack: 0, release: 0, seconds: 2 })), 160);
    expect(Math.min(...beat)).toBeLessThan(0.3); // two voices 2 Hz apart cancel twice a second
  });

  it('a spectrum shows the note at the right height', () => {
    const a = synth(spec({ notes: 'A4', beat: 0, attack: 0, release: 0, seconds: 1 }));
    const h = 64;
    const g = spectrogram(a, 4, h, 55, 2000);
    let best = 0;
    for (let y = 0; y < h; y++) if (g[y * 4 + 1] > g[best * 4 + 1]) best = y;
    const f = 55 * (2000 / 55) ** (1 - (best + 0.5) / h);
    expect(Math.abs(Math.log2(f / 440))).toBeLessThan(0.1);
  });

  it('renders every view at the requested size', () => {
    const a = synth(spec({}));
    for (const view of ['bars', 'wave', 'spectrum'] as const)
      for (const drawn of [false, true]) {
        const s = spec({ view, drawn, aspect: 2 });
        const { w, h } = soundSize(s, 128);
        const g = renderSound(a, s, w, h);
        expect([g.w, g.h]).toEqual([128, 64]);
        expect(g.data.every((x) => x >= 0 && x <= 1)).toBe(true);
      }
    // a drawn waveform is dark marks on white
    const d = renderSound(a, spec({ view: 'bars', drawn: true }), 64, 32);
    expect(new Set(d.data)).toEqual(new Set([0, 1]));
  });
});
