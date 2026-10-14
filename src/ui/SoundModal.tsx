import { useEffect, useMemo, useRef, useState } from 'react';
import { renderSound, soundSize, type SoundSpec, type SoundView, type Wave } from '../core/sound';
import { parseNoteList } from '../core/tuning';
import { ASPECTS } from './PatternModal';
import { paintGray } from './surfaces';
import { audioFor, playAudio, readAudio, soundDataUrl, stopAudio } from './audio';

const CHIPS: { label: string; notes: string }[] = [
  { label: 'A major', notes: 'A3 C#4 E4' },
  { label: 'A minor', notes: 'A3 C4 E4' },
  { label: 'C major 7', notes: 'C3 E3 G3 B3' },
  { label: 'Open fifth', notes: 'C3 G3 C4' },
  { label: 'Single A', notes: 'A3' },
];

function Num({ label, value, min, max, step = 0.01, onChange, unit = '' }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="pm-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="mono">
        {step >= 1 ? value : value.toFixed(2)}
        {unit}
      </span>
    </label>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="pm-row">
      <span>{label}</span>
      <span className="seg pm-seg">
        {options.map((o) => (
          <button key={o.value} type="button" className={`btn sm ${value === o.value ? 'on' : ''}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

const VIEW_NOTE: Record<SoundView, string> = {
  bars: 'Loudness over time. In the side profile each column is one plate, so the stack becomes a sound-wave sculpture.',
  wave: 'The waveform itself, a few cycles wide: plate heights trace the oscillation along the stack.',
  spectrum: 'Time across, pitch up the picture (low at the bottom), bright = loud. Reads well pressed into the top surface.',
};

export default function SoundModal({ title, initial, onApply, onClose }: { title: string; initial: SoundSpec; onApply: (spec: SoundSpec, dataUrl: string) => void; onClose: () => void }) {
  const [spec, setSpec] = useState<SoundSpec>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fileTick, setFileTick] = useState(0);
  const ref = useRef<HTMLCanvasElement>(null);
  const set = (patch: Partial<SoundSpec>) => setSpec((s) => ({ ...s, ...patch }));

  const audio = useMemo(() => audioFor(spec), [spec.source, spec.notes, spec.wave, spec.seconds, spec.glide, spec.beat, spec.attack, spec.release, spec.fileName, fileTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => {
    if (!audio) return null;
    const { w, h } = soundSize(spec, 300);
    return renderSound(audio, spec, w, h);
  }, [audio, spec]);
  useEffect(() => {
    if (ref.current && preview) paintGray(ref.current, preview);
  }, [preview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stopAudio();
    };
  }, [onClose]);

  const [aspects] = useState(() =>
    ASPECTS.some((a) => Math.abs(a.value - initial.aspect) < 1e-3) ? ASPECTS : [{ value: initial.aspect, label: `${initial.aspect.toFixed(2)} : 1 (stack)` }, ...ASPECTS],
  );
  const noteCount = parseNoteList(spec.notes).length;
  const missingFile = spec.source === 'file' && !audio;

  const load = async () => {
    setError(null);
    try {
      const r = await readAudio();
      if (!r) return;
      set({ source: 'file', fileName: r.name });
      setFileTick((t) => t + 1);
    } catch {
      setError("Couldn't read that file. Try a WAV or MP3.");
    }
  };

  return (
    <div className="pm-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm" role="dialog" aria-modal="true" aria-label={title}>
        <div className="box-head">
          <span>{title}</span>
          <button className="btn sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="pm-body">
          <div className="pm-left">
            <div className="pm-preview">
              {preview ? <canvas ref={ref} style={{ aspectRatio: `${preview.w} / ${preview.h}` }} /> : <div className="empty">{missingFile ? 'Load a sound file' : 'Type some notes'}</div>}
            </div>
            <div className="note">{VIEW_NOTE[spec.view]}</div>
            <div className="btnrow" style={{ padding: 0 }}>
              <button className="btn sm" disabled={!audio} onClick={() => audio && playAudio(audio)}>
                ▶ Play
              </button>
              <button className="btn sm" onClick={stopAudio}>
                Stop
              </button>
            </div>
            <div className="pm-row">
              <span>Frame</span>
              <select value={aspects.find((a) => Math.abs(a.value - spec.aspect) < 1e-3)?.value ?? 1} onChange={(e) => set({ aspect: Number(e.target.value) })} aria-label="Frame proportions">
                {aspects.map((a) => (
                  <option key={a.label} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="pm-right">
            <Seg
              label="Sound"
              value={spec.source}
              options={[
                { value: 'tone', label: 'Tone / chord' },
                { value: 'file', label: 'Sound file' },
              ]}
              onChange={(v) => set({ source: v })}
            />
            {spec.source === 'tone' ? (
              <>
                <label className="pm-row">
                  <span>Notes</span>
                  <input className="inp" style={{ flex: 1, fontFamily: 'var(--mono)' }} value={spec.notes} onChange={(e) => set({ notes: e.target.value })} aria-label="Notes" />
                </label>
                {noteCount === 0 && <div className="note" style={{ color: 'var(--warn)' }}>Use note names like A3 C#4 E4 (A4 = 440 Hz).</div>}
                <div className="pm-presets">
                  {CHIPS.map((c) => (
                    <button key={c.label} className={`btn sm ${spec.notes === c.notes ? 'on' : ''}`} onClick={() => set({ notes: c.notes })}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <Seg<Wave>
                  label="Wave"
                  value={spec.wave}
                  options={[
                    { value: 'sine', label: 'Sine' },
                    { value: 'triangle', label: 'Triangle' },
                    { value: 'saw', label: 'Saw' },
                    { value: 'square', label: 'Square' },
                  ]}
                  onChange={(v) => set({ wave: v })}
                />
                <Num label="Length" value={spec.seconds} min={0.2} max={10} step={0.1} unit="s" onChange={(v) => set({ seconds: v })} />
                <Num label="Glide" value={spec.glide ?? 0} min={-24} max={24} step={1} unit="st" onChange={(v) => set({ glide: v })} />
                <Num label="Beat (pulse)" value={spec.beat} min={0} max={8} step={0.1} unit="Hz" onChange={(v) => set({ beat: v })} />
                <Num label="Fade in" value={spec.attack} min={0} max={1} onChange={(v) => set({ attack: v })} />
                <Num label="Fade out" value={spec.release} min={0} max={1} onChange={(v) => set({ release: v })} />
              </>
            ) : (
              <div className="pm-row">
                <span>File</span>
                <button className="btn sm primary" onClick={load}>
                  Load sound…
                </button>
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {spec.fileName ?? 'none'}
                </span>
              </div>
            )}
            {missingFile && spec.fileName && <div className="note">The recording isn't saved in the project, only its picture. Load {spec.fileName} again to change it.</div>}
            {error && <div className="note" style={{ color: 'var(--err)' }}>{error}</div>}

            <div className="pm-group">Picture</div>
            <Seg<SoundView>
              label="Show"
              value={spec.view}
              options={[
                { value: 'bars', label: 'Loudness' },
                { value: 'wave', label: 'Waveform' },
                { value: 'spectrum', label: 'Spectrum' },
              ]}
              onChange={(v) => set({ view: v })}
            />
            {spec.view === 'wave' && spec.source === 'tone' && <Num label="Cycles across" value={spec.cycles} min={0.5} max={20} step={0.5} onChange={(v) => set({ cycles: v })} />}
            {spec.view !== 'spectrum' && (
              <label className="pm-row">
                <span>Draw it</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" className="chk" checked={spec.drawn} onChange={(e) => set({ drawn: e.target.checked })} />
                  <small>Dark waveform drawing on white, for the top or front. Off: brightness is height, for the side profile.</small>
                </span>
              </label>
            )}
            <Num label="Smoothing" value={spec.smooth} min={0} max={0.1} step={0.005} onChange={(v) => set({ smooth: v })} />
          </div>
        </div>
        <div className="btnrow" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--line)' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!audio}
            onClick={() => {
              const url = soundDataUrl(spec, audio);
              if (url) onApply(spec, url);
            }}
          >
            Use sound
          </button>
        </div>
      </div>
    </div>
  );
}
