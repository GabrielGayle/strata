// Shaping controls for an image made by "Depth from photo": the real depth (metres)
// is kept on the image, so these re-shape it live without asking the service again.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { DEPTH_RESOLUTIONS, decodeDepthBuffers, depthToGray, type DepthData, type DepthSettings } from '../core/depth';
import {
  DEFAULT_FLAT_PERCENTILE,
  FLAT_LEVEL_MODES,
  fillFlatDefaults,
  isEngagedFlatMode,
  isFlatDirty,
  isMapDepthFace,
  resetFlatToAuto,
  resolveFlatLevel,
  type FlatLevelMode,
} from '../core/depthFlat';
import { mapDepthToGray } from '../core/mapPlateHeight';
import { grayDataUrl } from './surfaces';

type Slot = 'top' | 'front' | 'side';

const SLIDER = 1000;

/**
 * Photo depth: log, so 0.5 m and 50 m both get room.
 * Map depth: linear in encoded metres — a log slider from the 0.001 m summit
 * floor to hundreds of metres puts 0.35/0.65 on a sliver of the peaks, which
 * flattens the plates to the 4 mm floor.
 */
function MetreSlider({
  label,
  value,
  lo,
  hi,
  onChange,
  title,
  linear = false,
}: {
  label: string;
  value: number;
  lo: number;
  hi: number;
  onChange: (m: number) => void;
  title: string;
  linear?: boolean;
}) {
  const span = Math.max(hi - lo, 1e-9);
  const a = Math.log(Math.max(lo, 1e-3));
  const b = Math.log(Math.max(hi, lo * 1.001));
  const t = linear
    ? Math.round(((Math.min(hi, Math.max(lo, value)) - lo) / span) * SLIDER)
    : Math.round(((Math.log(Math.max(value, 1e-3)) - a) / (b - a)) * SLIDER);
  const fromT = (raw: number) => (linear ? lo + (raw / SLIDER) * span : Math.exp(a + (raw / SLIDER) * (b - a)));
  return (
    <label className="field-row pm-row" title={title}>
      <span>{label}</span>
      <input type="range" min={0} max={SLIDER} step={1} value={Math.min(SLIDER, Math.max(0, t))} onChange={(e) => onChange(fromT(Number(e.target.value)))} aria-label={label} />
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
  const resetDepthToAuto = useStore((s) => s.resetDepthToAuto);
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
      const gray = depth.mapOrtho?.source === 'map' ? mapDepthToGray(depth) : depthToGray(depth);
      setDepthSettings(slot, {}, grayDataUrl(gray));
    }, 300);
    return () => clearTimeout(t);
  }, [depth, slot, setDepthSettings]);
  const lo = depth.minM;
  const hi = depth.maxM;
  const mapFace = isMapDepthFace(depth);
  return (
    <div className="depth-ctl">
      {depth.photo && <PhotoThumb src={depth.photo} />}
      <div className="note">
        {mapFace
          ? `Map elevation: ${depth.w}×${depth.h}, ${metres(lo)} to ${metres(hi)} (exaggerated metres). Near/far window the terrain; flatten, curve and perspective do not apply to plate heights.`
          : `Depth map: ${depth.w}×${depth.h}, ${metres(lo)} to ${metres(hi)}. These shape the real depth, not the grey picture.`}
      </div>
      <MetreSlider
        label="Near"
        value={s.near}
        lo={lo}
        hi={hi}
        linear={mapFace}
        onChange={(m) => set({ near: Math.min(m, s.far * 0.98) })}
        title="Anything nearer than this is full height"
      />
      <MetreSlider
        label="Far"
        value={s.far}
        lo={lo}
        hi={hi}
        linear={mapFace}
        onChange={(m) => set({ far: Math.max(m, s.near * 1.02) })}
        title="Anything farther than this is background: white, left uncut"
      />
      <Num label="Curve" value={s.curve} min={0.3} max={3} step={0.05} show={s.curve.toFixed(2)} onChange={(v) => set({ curve: v })} title="Below 1 lifts the low parts, above 1 sinks them so only the nearest parts stand out" />
      <Num label="Flatten" value={s.flatten} min={0} max={1} step={0.05} show={`${Math.round(s.flatten * 100)}%`} onChange={(v) => set({ flatten: v })} title="Flattens the big shapes and lifts what sits on them. For soft, low reliefs try Bas-relief below." />
      {!mapFace && <BasReliefControls s={s} hasMask={!!depth.mask} set={set} />}
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
        <button
          type="button"
          className="btn sm"
          onClick={() => resetDepthToAuto(slot)}
          title="Reset near, far, curve and spacing to automatic values from the depth data"
        >
          Reset to auto
        </button>
      </div>
      {slot === 'side' && !mapFace && <SideCutControls />}
      <FlatPlateControls depth={depth} set={set} />
    </div>
  );
}

/** Bas-relief (squash the jumps), incised outline and feathered cut-out: image depth only. */
function BasReliefControls({ s, hasMask, set }: { s: DepthSettings; hasMask: boolean; set: (patch: Partial<DepthSettings>) => void }) {
  const squash = s.squash ?? 0;
  const outline = s.outline ?? 0;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="depth-bas" data-testid="bas-relief">
      <Num
        label="Bas-relief"
        value={squash}
        min={0}
        max={1}
        step={0.05}
        show={squash > 0 ? pct(squash) : 'off'}
        onChange={(v) => set({ squash: v })}
        title="Squashes the big jumps (a hand on a body, the figure's edge) into soft ramps and keeps the fine detail, so a figure reads in a few millimetres without walls"
      />
      {squash > 0 && (
        <>
          <Num label="Keep detail" value={s.detail ?? 1} min={1} max={3} step={0.1} show={`${(s.detail ?? 1).toFixed(1)}×`} onChange={(v) => set({ detail: v })} title="Sharpens the fine forms (knuckles, folds) that the squash would otherwise soften" />
          <Num
            label="Outline"
            value={outline}
            min={0}
            max={0.3}
            step={0.01}
            show={outline > 0 ? pct(outline) : 'off'}
            onChange={(v) => set({ outline: v })}
            title="Cuts a fine groove where the depth used to jump, so fingers and edges stay crisp. Depth as a share of the relief."
          />
          {outline > 0 && (
            <Num label="Line width" value={s.outlineWidth ?? 1.5} min={0.5} max={6} step={0.25} show={`${(s.outlineWidth ?? 1.5).toFixed(2)} px`} onChange={(v) => set({ outlineWidth: v })} title="How wide the groove is, in pixels of a 512 px depth map" />
          )}
        </>
      )}
      {hasMask && s.matte && (
        <Num
          label="Feather"
          value={s.feather ?? 0}
          min={0}
          max={10}
          step={0.25}
          show={(s.feather ?? 0) > 0 ? `${(s.feather ?? 0).toFixed(2)}%` : 'off'}
          onChange={(v) => set({ feather: v })}
          title="The subject rolls down into the background over this share of the picture, instead of stopping at a wall"
        />
      )}
    </div>
  );
}

/** The photo the depth came from: a small thumbnail, tap for a bigger look. */
function PhotoThumb({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  return (
    <>
      <button type="button" className="depth-photo" onClick={() => setOpen(true)} title="The photo this depth came from. Click to see it bigger." data-testid="depth-photo">
        <img src={src} alt="Original photo" />
        <span>Original photo</span>
      </button>
      {open && (
        <div className="pm-back" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="window pm depth-photo-window" role="dialog" aria-modal="true" aria-label="Original photo">
            <div className="title-bar">
              <div className="title-bar-text">Original photo</div>
              <div className="title-bar-controls">
                <button type="button" aria-label="Close" onClick={() => setOpen(false)} />
              </div>
            </div>
            <div className="window-body">
              <img src={src} alt="Original photo, larger" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Parameters › Image › No plate below / above, beside the depth they act on. */
function SideCutControls() {
  const params = useStore((st) => st.project.params);
  const setParam = useStore((st) => st.setParam);
  if (String(params.imgSideMode ?? 'off') !== 'heightmap') return null;
  const num = (id: string, def: number) => {
    const n = Number(params[id]);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : def;
  };
  const lo = num('imgCutLow', 0);
  const hi = num('imgCutHigh', 100);
  return (
    <fieldset className="flat-plate-ctl" data-testid="side-cut">
      <legend>No plates</legend>
      <div className="note">Where the picture is darker or lighter than these, the plates are cut away and leave a gap. A few % below clears a black background.</div>
      <Num
        label="Below"
        value={lo}
        min={0}
        max={50}
        step={1}
        show={lo > 0 ? `${lo}%` : 'off'}
        onChange={(v) => setParam('imgCutLow', String(Math.min(v, hi - 1)))}
        title="No plate where the picture is darker than this (Parameters › Image › No plate below)"
      />
      <Num
        label="Above"
        value={hi}
        min={50}
        max={100}
        step={1}
        show={hi < 100 ? `${hi}%` : 'off'}
        onChange={(v) => setParam('imgCutHigh', String(Math.max(v, lo + 1)))}
        title="No plate where the picture is lighter than this (Parameters › Image › No plate above)"
      />
    </fieldset>
  );
}

function modeLabel(m: FlatLevelMode) {
  return m === 'off' ? 'Off' : m === 'auto' ? 'Auto' : m === 'plateau' ? 'Plateau' : m === 'percentile' ? 'Percentile' : 'Eyedropper';
}

function modeTitle(m: FlatLevelMode) {
  return m === 'off'
    ? 'Leave the depth map as it is'
    : m === 'auto'
      ? 'Pick a background plateau or far percentile'
      : m === 'plateau'
        ? 'Largest far-distance plateau in the depth map'
        : m === 'percentile'
          ? 'A fraction of the near–far depth span becomes the plate'
          : 'Click the depth preview to pick a level';
}

function displayedMode(s: ReturnType<typeof fillFlatDefaults>): FlatLevelMode {
  if (s.flatLevelMode === 'off') return 'off';
  if (isEngagedFlatMode(s.flatLevelMode)) return s.flatLevelMode;
  return s.flatLevelOverride ? 'auto' : 'off';
}

function FlatPlateControls({ depth, set }: { depth: DepthData; set: (patch: Partial<DepthSettings>) => void }) {
  if (isMapDepthFace(depth)) return null;
  const s = fillFlatDefaults(depth.settings);
  const mode = displayedMode(s);
  const on = isEngagedFlatMode(mode);
  const { metres } = decodeDepthBuffers(depth);
  const resolved = resolveFlatLevel(metres, depth, s);
  const engage = (patch: Partial<DepthSettings>) => set({ flatLevelMode: on ? mode : 'auto', ...patch });
  return (
    <fieldset className="flat-plate-ctl" data-testid="flat-plate" data-mode={mode} data-override={s.flatLevelOverride ? '1' : '0'}>
      <legend>Background to plate flat</legend>
      <div className="note">
        {on
          ? 'Everything at or beyond this level becomes one flat plate. Map faces skip this and stay in real metres.'
          : 'Off: depth is unchanged. Pick Auto, Plateau, Percentile or Eyedropper to flatten the backdrop.'}
      </div>
      <div className="field-row pm-row">
        <span>Mode</span>
        <span className="seg pm-seg" role="group" aria-label="Flat level mode">
          {FLAT_LEVEL_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`btn sm ${mode === m ? 'on' : ''}`}
              onClick={() => set({ flatLevelMode: m, flatLevelOverride: m === 'off' ? false : m === 'eyedropper' ? s.flatLevelOverride === true : false })}
              title={modeTitle(m)}
            >
              {modeLabel(m)}
            </button>
          ))}
        </span>
      </div>
      {on && (
        <>
          <MetreSlider
            label="Flat level"
            value={resolved.levelM}
            lo={depth.minM}
            hi={depth.maxM}
            onChange={(m) => engage({ flatLevel: m, flatLevelOverride: true })}
            title="Depth in metres: everything at or beyond this is flattened to a plate"
          />
          {mode === 'percentile' && (
            <Num
              label="Percentile"
              value={s.flatPercentile ?? DEFAULT_FLAT_PERCENTILE}
              min={50}
              max={99}
              step={1}
              show={`${Math.round(s.flatPercentile ?? DEFAULT_FLAT_PERCENTILE)}`}
              onChange={(v) => engage({ flatPercentile: v, flatLevelMode: 'percentile', flatLevelOverride: false })}
              title="Fraction of the near–far depth span: farther than this becomes the plate"
            />
          )}
          <Num
            label="Edge ease"
            value={s.edgeEase ?? 0}
            min={0}
            max={1}
            step={0.02}
            show={s.edgeEase ? `${Math.round((s.edgeEase ?? 0) * 100)}%` : 'off'}
            onChange={(v) => engage({ edgeEase: v })}
            title="Smooth falloff into the flat region, as a fraction of the near–far span"
          />
          <Num
            label="Step limit"
            value={s.stepLimit ?? 0}
            min={0}
            max={0.25}
            step={0.005}
            show={s.stepLimit ? (s.stepLimit ?? 0).toFixed(2) : 'off'}
            onChange={(v) => engage({ stepLimit: v })}
            title="Max height change between adjacent samples (0 = no limit)"
          />
          <label className="field-row pm-row" title="Also raise any dips below the plate so nothing sits under the background">
            <span>Negative</span>
            <input type="checkbox" checked={s.flatNegative === true} onChange={(e) => engage({ flatNegative: e.target.checked })} aria-label="Flatten the negative side" />
            <span className="flat-plate-check">Flatten the negative side</span>
          </label>
          {mode === 'eyedropper' && <div className="note">Click the depth preview to pick a level.</div>}
          {isFlatDirty(s) && (
            <div className="btnrow" style={{ padding: 0 }}>
              <button type="button" className="btn sm" onClick={() => set(resetFlatToAuto(s))} title="Clear the locked level, Edge ease, Step limit and Flatten negative, and go back to Auto">
                Reset to auto
              </button>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
