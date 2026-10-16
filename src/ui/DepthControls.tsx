// Shaping controls for an image made by "Depth from photo": the real depth (metres)
// is kept on the image, so these re-shape it live without asking the service again.
import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { DEPTH_RESOLUTIONS, defaultDepthSettings, depthToGray, type DepthData, type DepthSettings } from '../core/depth';
import { grayDataUrl } from './surfaces';

type Slot = 'top' | 'front' | 'side';

const SLIDER = 1000;

/** Metres on a log slider, so 0.5 m and 50 m both get room. */
function MetreSlider({ label, value, lo, hi, onChange, title }: { label: string; value: number; lo: number; hi: number; onChange: (m: number) => void; title: string }) {
  const a = Math.log(Math.max(lo, 1e-3));
  const b = Math.log(Math.max(hi, lo * 1.001));
  const t = Math.round(((Math.log(Math.max(value, 1e-3)) - a) / (b - a)) * SLIDER);
  return (
    <label className="field-row pm-row" title={title}>
      <span>{label}</span>
      <input type="range" min={0} max={SLIDER} step={1} value={Math.min(SLIDER, Math.max(0, t))} onChange={(e) => onChange(Math.exp(a + (Number(e.target.value) / SLIDER) * (b - a)))} aria-label={label} />
      <span className="mono">{metres(value)}</span>
    </label>
  );
}

function metres(m: number) {
  return m < 1 ? `${Math.round(m * 100)} cm` : m < 10 ? `${m.toFixed(2)} m` : `${m.toFixed(1)} m`;
}

function Num({ label, value, min, max, step, onChange, title, show }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; title: string; show: string }) {
  return (
    <label className="field-row pm-row" title={title}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="mono">{show}</span>
    </label>
  );
}

export default function DepthControls({ slot, depth }: { slot: Slot; depth: DepthData }) {
  const setDepthSettings = useStore((s) => s.setDepthSettings);
  const s = depth.settings;
  // refresh the stored picture (thumbnails, composer) once the sliders settle; the pipeline reads the depth itself.
  // Only after a change made here, so undo / redo don't write a new step.
  const pending = useRef(false);
  const set = (patch: Partial<DepthSettings>) => {
    pending.current = true;
    setDepthSettings(slot, patch);
  };
  useEffect(() => {
    if (!pending.current) return;
    const t = setTimeout(() => {
      pending.current = false;
      setDepthSettings(slot, {}, grayDataUrl(depthToGray(depth)));
    }, 300);
    return () => clearTimeout(t);
  }, [depth, slot, setDepthSettings]);
  const lo = depth.minM;
  const hi = depth.maxM;
  return (
    <div className="depth-ctl">
      <div className="note">
        Depth map: {depth.w}×{depth.h}, {metres(lo)} to {metres(hi)}. These shape the real depth, not the grey picture.
      </div>
      <MetreSlider label="Near" value={s.near} lo={lo} hi={hi} onChange={(m) => set({ near: Math.min(m, s.far * 0.98) })} title="Anything nearer than this is full height" />
      <MetreSlider label="Far" value={s.far} lo={lo} hi={hi} onChange={(m) => set({ far: Math.max(m, s.near * 1.02) })} title="Anything farther than this is background: white, left uncut" />
      <Num label="Curve" value={s.curve} min={0.3} max={3} step={0.05} show={s.curve.toFixed(2)} onChange={(v) => set({ curve: v })} title="Below 1 lifts the low parts, above 1 sinks them so only the nearest parts stand out" />
      <Num label="Flatten" value={s.flatten} min={0} max={1} step={0.05} show={`${Math.round(s.flatten * 100)}%`} onChange={(v) => set({ flatten: v })} title="Bas-relief squash: flattens the big shapes and keeps the fine detail, so it reads in a few millimetres" />
      <div className="field-row pm-row">
        <span>Spacing</span>
        <span className="seg pm-seg">
          <button type="button" className={`btn sm ${s.spacing === 'perspective' ? 'on' : ''}`} onClick={() => set({ spacing: 'perspective' })} title="Even in 1/distance, like the eye sees: more height for near detail">
            Perspective
          </button>
          <button type="button" className={`btn sm ${s.spacing === 'linear' ? 'on' : ''}`} onClick={() => set({ spacing: 'linear' })} title="Even in metres: true-to-scale depth between near and far">
            Linear
          </button>
        </span>
      </div>
      <div className="field-row pm-row">
        <span>Resolution</span>
        <span className="seg pm-seg">
          {DEPTH_RESOLUTIONS.filter((r) => r <= Math.max(depth.w, depth.h)).map((r) => (
            <button key={r} type="button" className={`btn sm ${s.resolution === r ? 'on' : ''}`} onClick={() => set({ resolution: r })} title={`Longest side ${r} px`}>
              {r}
            </button>
          ))}
        </span>
      </div>
      <div className="btnrow" style={{ padding: 0 }}>
        {depth.mask && (
          <button type="button" className={`btn sm ${s.matte ? 'on' : ''}`} onClick={() => set({ matte: !s.matte })} title="Keep only the subject the service found; the rest stays white (uncut)">
            Cut out subject
          </button>
        )}
        <button type="button" className={`btn sm ${s.invert ? 'on' : ''}`} onClick={() => set({ invert: !s.invert })} title="Near reads light instead of dark">
          Invert
        </button>
        <button type="button" className="btn sm" onClick={() => set({ ...defaultDepthSettings(depth, slot === 'side'), resolution: s.resolution })} title="Back to the service's own near / far and a straight curve">
          Auto
        </button>
      </div>
    </div>
  );
}
