import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PATTERN_PRESETS,
  SHAPES,
  makeLayer,
  patternSize,
  randomLayer,
  renderPattern,
  type PatternLayer,
  type PatternSpec,
} from '../core/pattern';
import type { Gray } from '../core/image';

const ASPECTS: { value: number; label: string }[] = [
  { value: 1, label: '1 : 1' },
  { value: 4 / 3, label: '4 : 3' },
  { value: 3 / 2, label: '3 : 2' },
  { value: 2, label: '2 : 1' },
  { value: 3, label: '3 : 1' },
  { value: 3 / 4, label: '3 : 4' },
  { value: 1 / 2, label: '1 : 2' },
];

function paint(cv: HTMLCanvasElement, g: Gray) {
  cv.width = g.w;
  cv.height = g.h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(g.w, g.h);
  for (let i = 0; i < g.w * g.h; i++) {
    const c = g.data[i] * 255;
    img.data[i * 4] = c;
    img.data[i * 4 + 1] = c;
    img.data[i * 4 + 2] = c;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Full-resolution PNG of a pattern, stored in the project like an uploaded image. */
export function patternDataUrl(spec: PatternSpec, long = 640): string {
  const { w, h } = patternSize(spec, long);
  const cv = document.createElement('canvas');
  paint(cv, renderPattern(spec, w, h));
  return cv.toDataURL('image/png');
}

function Num({ label, value, min, max, step = 0.01, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="pm-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="mono">{step >= 1 ? value : value.toFixed(2)}</span>
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
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

export default function PatternModal({ title, initial, onApply, onClose }: { title: string; initial: PatternSpec; onApply: (spec: PatternSpec) => void; onClose: () => void }) {
  const [spec, setSpec] = useState<PatternSpec>(initial);
  const [sel, setSel] = useState(0);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const ref = useRef<HTMLCanvasElement>(null);
  const layer = spec.layers[Math.min(sel, spec.layers.length - 1)];

  // live preview at a modest resolution; the stored image is rendered larger on apply
  const preview = useMemo(() => {
    const { w, h } = patternSize(spec, 280);
    return renderPattern(spec, w, h);
  }, [spec]);
  useEffect(() => {
    if (ref.current) paint(ref.current, preview);
  }, [preview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setLayer = (patch: Partial<PatternLayer>) => setSpec((s) => ({ ...s, layers: s.layers.map((l, i) => (i === sel ? { ...l, ...patch } : l)) }));
  const shuffle = () => {
    const next = seed + 1;
    setSeed(next);
    setSpec((s) => ({ ...s, layers: s.layers.map((l, i) => (i === sel ? randomLayer(next, { strength: l.strength, blend: l.blend }) : l)) }));
  };
  // keep a custom proportion (e.g. the stack's footprint) selectable alongside the standard ones
  const [aspects] = useState(() =>
    ASPECTS.some((a) => Math.abs(a.value - initial.aspect) < 1e-3) ? ASPECTS : [{ value: initial.aspect, label: `${initial.aspect.toFixed(2)} : 1 (stack)` }, ...ASPECTS],
  );
  const tiled = layer.tiling !== 'single';
  const s = layer.shape;

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
              <canvas ref={ref} style={{ aspectRatio: `${preview.w} / ${preview.h}` }} />
            </div>
            <div className="note">Dark cuts deepest. Soft edges give domed heights; solid edges give crisp steps.</div>
            <div className="pm-presets">
              {PATTERN_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className="btn sm"
                  onClick={() => {
                    const next = p.spec();
                    // keep the chosen frame unless the preset needs its own (e.g. a wide text banner)
                    setSpec(next.aspect === 1 ? { ...next, aspect: spec.aspect, invert: spec.invert } : next);
                    setSel(0);
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="pm-row">
              <span>Frame</span>
              <select value={aspects.find((a) => Math.abs(a.value - spec.aspect) < 1e-3)?.value ?? 1} onChange={(e) => setSpec({ ...spec, aspect: Number(e.target.value) })} aria-label="Frame proportions">
                {aspects.map((a) => (
                  <option key={a.label} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" className="chk" checked={spec.invert} onChange={(e) => setSpec({ ...spec, invert: e.target.checked })} /> Invert
              </label>
            </div>
          </div>
          <div className="pm-right">
            <div className="pm-layers">
              {spec.layers.map((l, i) => (
                <button key={i} className={`btn sm ${i === sel ? 'on' : ''}`} onClick={() => setSel(i)}>
                  {i + 1} · {SHAPES.find((x) => x.value === l.shape)?.label}
                </button>
              ))}
              <button
                className="btn sm"
                disabled={spec.layers.length >= 4}
                onClick={() => {
                  setSpec({ ...spec, layers: [...spec.layers, makeLayer({ shape: 'text', tiling: 'single', size: 0.4, outline: 0.25 })] });
                  setSel(spec.layers.length);
                }}
                title="Add a layer on top"
              >
                + Layer
              </button>
              <button
                className="btn sm"
                disabled={spec.layers.length <= 1}
                onClick={() => {
                  setSpec({ ...spec, layers: spec.layers.filter((_, i) => i !== sel) });
                  setSel(Math.max(0, sel - 1));
                }}
              >
                Remove
              </button>
              <button className="btn sm primary" onClick={shuffle} title="Random shape, layout and symmetry for this layer">
                Shuffle
              </button>
            </div>

            <div className="pm-group">Shape</div>
            <div className="pm-shapes">
              {SHAPES.map((o) => (
                <button key={o.value} className={`btn sm ${s === o.value ? 'on' : ''}`} onClick={() => setLayer({ shape: o.value })}>
                  {o.label}
                </button>
              ))}
            </div>
            {s === 'text' && (
              <label className="pm-row">
                <span>Text</span>
                <textarea rows={2} value={layer.text} onChange={(e) => setLayer({ text: e.target.value })} aria-label="Text" style={{ flex: 1, fontFamily: 'var(--mono)', textTransform: 'uppercase' }} />
              </label>
            )}
            {(s === 'polygon' || s === 'star') && <Num label={s === 'star' ? 'Points' : 'Sides'} value={layer.sides} min={s === 'star' ? 2 : 3} max={16} step={1} onChange={(v) => setLayer({ sides: v })} />}
            {s === 'star' && <Num label="Inner radius" value={layer.inner} min={0.05} max={0.95} onChange={(v) => setLayer({ inner: v })} />}
            {s === 'rose' && <Num label="Petals" value={layer.petals} min={1} max={12} step={1} onChange={(v) => setLayer({ petals: v })} />}
            {s === 'superformula' && (
              <>
                <Num label="Symmetry m" value={layer.m} min={0} max={20} step={1} onChange={(v) => setLayer({ m: v })} />
                <Num label="Pinch n1" value={layer.n1} min={0.1} max={4} onChange={(v) => setLayer({ n1: v })} />
                <Num label="n2" value={layer.n2} min={0.1} max={4} onChange={(v) => setLayer({ n2: v })} />
                <Num label="n3" value={layer.n3} min={0.1} max={4} onChange={(v) => setLayer({ n3: v })} />
              </>
            )}
            <Num label={s === 'text' ? 'Letter height' : 'Size'} value={layer.size} min={0.05} max={s === 'text' ? 1 : 1.5} onChange={(v) => setLayer({ size: v })} />
            <Num label="Rotate" value={layer.rotate} min={-180} max={180} step={1} onChange={(v) => setLayer({ rotate: v })} />
            <Num label={s === 'text' ? 'Stroke weight' : 'Outline (0 = filled)'} value={layer.outline} min={0} max={s === 'text' ? 1 : 0.6} onChange={(v) => setLayer({ outline: v })} />
            {s !== 'text' && (
              <>
                <Num label="Echo rings" value={layer.echoes} min={0} max={8} step={1} onChange={(v) => setLayer({ echoes: v })} />
                {layer.echoes > 0 && <Num label="Ring gap" value={layer.echoGap} min={0.05} max={1} onChange={(v) => setLayer({ echoGap: v })} />}
              </>
            )}

            <div className="pm-group">Layout</div>
            <Choice
              label="Repeat"
              value={layer.tiling}
              options={[
                { value: 'single', label: 'Single' },
                { value: 'grid', label: 'Grid' },
                { value: 'brick', label: 'Brick' },
                { value: 'hex', label: 'Hex' },
              ]}
              onChange={(v) => setLayer({ tiling: v })}
            />
            {tiled && <Num label="Cells across" value={layer.cells} min={1} max={24} step={1} onChange={(v) => setLayer({ cells: v })} />}
            <Choice
              label="Symmetry"
              value={layer.symmetry}
              options={[
                { value: 'none', label: 'None' },
                { value: 'radial', label: 'Radial' },
                { value: 'kaleido', label: 'Kaleidoscope' },
              ]}
              onChange={(v) => setLayer({ symmetry: v })}
            />
            {layer.symmetry !== 'none' && (
              <>
                <Num label={layer.symmetry === 'radial' ? 'Copies' : 'Segments'} value={layer.folds} min={2} max={24} step={1} onChange={(v) => setLayer({ folds: v })} />
                <Num label="Distance from centre" value={layer.offset} min={-1} max={1.5} onChange={(v) => setLayer({ offset: v })} />
              </>
            )}

            <div className="pm-group">Depth</div>
            <Choice
              label="Edge"
              value={layer.edge}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'soft', label: 'Soft dome' },
              ]}
              onChange={(v) => setLayer({ edge: v })}
            />
            {layer.edge === 'soft' && <Num label="Softness" value={layer.softness} min={0.05} max={2} onChange={(v) => setLayer({ softness: v })} />}
            <Num label="Strength" value={layer.strength} min={0} max={1} onChange={(v) => setLayer({ strength: v })} />
            {sel > 0 && (
              <Choice
                label="Blend"
                value={layer.blend}
                options={[
                  { value: 'add', label: 'Add' },
                  { value: 'cut', label: 'Cut away' },
                ]}
                onChange={(v) => setLayer({ blend: v })}
              />
            )}
          </div>
        </div>
        <div className="btnrow" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--line)' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onApply(spec)}>
            Use pattern
          </button>
        </div>
      </div>
    </div>
  );
}
