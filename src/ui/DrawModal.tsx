// Freeform drawing pad. Strokes are stored (not pixels) so a drawing can be
// reopened and edited; the pad shows the same render the composer uses.
import { useEffect, useMemo, useRef, useState } from 'react';
import { renderDrawing, type DrawingSpec, type Stroke } from '../core/compose';
import { ASPECTS } from './PatternModal';
import { paintGray } from './surfaces';

const TONES: { value: number; label: string }[] = [
  { value: 0, label: 'Black' },
  { value: 0.35, label: 'Dark grey' },
  { value: 0.7, label: 'Light grey' },
  { value: 1, label: 'Eraser' },
];

export default function DrawModal({ initial, onApply, onClose }: { initial: DrawingSpec; onApply: (spec: DrawingSpec) => void; onClose: () => void }) {
  const [spec, setSpec] = useState<DrawingSpec>(initial);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [size, setSize] = useState(0.04);
  const [tone, setTone] = useState(0);
  const [soft, setSoft] = useState(0.3);
  const base = useRef<HTMLCanvasElement>(null);
  const live = useRef<HTMLCanvasElement>(null);
  const cur = useRef<number[] | null>(null);
  const a = Math.max(0.1, spec.aspect);
  const W = a >= 1 ? 560 : Math.round(560 * a);
  const H = a >= 1 ? Math.round(560 / a) : 560;
  const g = useMemo(() => renderDrawing(spec, W, H), [spec, W, H]);
  useEffect(() => {
    if (base.current) paintGray(base.current, g);
  }, [g]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') onClose();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoStroke();
        else undoStroke();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const undoStroke = () => {
    if (!spec.strokes.length) return;
    setRedo([spec.strokes[spec.strokes.length - 1], ...redo]);
    setSpec({ ...spec, strokes: spec.strokes.slice(0, -1) });
  };
  const redoStroke = () => {
    if (!redo.length) return;
    setSpec({ ...spec, strokes: [...spec.strokes, redo[0]] });
    setRedo(redo.slice(1));
  };

  const pt = (e: React.PointerEvent) => {
    const r = live.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const drawLive = () => {
    const cv = live.current;
    const p = cur.current;
    if (!cv || !p) return;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    const c = Math.round(tone * 255);
    ctx.strokeStyle = ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.lineWidth = size * H;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p[0] * W, p[1] * H);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * H);
    if (p.length === 2) ctx.lineTo(p[0] * W + 0.01, p[1] * H);
    ctx.stroke();
  };
  const end = () => {
    const p = cur.current;
    cur.current = null;
    const cv = live.current;
    if (cv) cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height);
    if (!p) return;
    setSpec((s) => ({ ...s, strokes: [...s.strokes, { pts: p.map((x) => +x.toFixed(4)), size, tone, soft }] }));
    setRedo([]);
  };

  return (
    <div className="pm-back" style={{ zIndex: 95 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="window pm" role="dialog" aria-modal="true" aria-label="Drawing pad">
        <div className="title-bar">
          <div className="title-bar-text">Drawing pad</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose}></button>
          </div>
        </div>
        <div className="window-body pm-body">
          <div className="pm-left">
            <div className="pm-preview draw-pad">
              <div className="draw-stack" style={{ aspectRatio: `${W} / ${H}` }}>
                <canvas ref={base} />
                <canvas
                  ref={live}
                  width={W}
                  height={H}
                  className="draw-live"
                  onPointerDown={(e) => {
                    (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    cur.current = pt(e);
                    drawLive();
                  }}
                  onPointerMove={(e) => {
                    if (!cur.current) return;
                    const [x, y] = pt(e);
                    const p = cur.current;
                    // skip points closer than a pixel or so to keep strokes light
                    if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) * H < 1.5) return;
                    p.push(x, y);
                    drawLive();
                  }}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
              </div>
            </div>
            <div className="note">Black cuts deepest, grey cuts part way, the eraser paints back to bare plate.</div>
          </div>
          <div className="pm-right">
            <div className="pm-group">Brush</div>
            <div className="field-row pm-row">
              <span>Tone</span>
              <span className="seg pm-seg">
                {TONES.map((t) => (
                  <button key={t.value} className={`btn sm ${tone === t.value ? 'on' : ''}`} onClick={() => setTone(t.value)}>
                    {t.label}
                  </button>
                ))}
              </span>
            </div>
            <label className="field-row pm-row">
              <span>Size</span>
              <input type="range" min={0.005} max={0.3} step={0.005} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Brush size" />
              <span className="mono">{(size * 100).toFixed(1)}</span>
            </label>
            <label className="field-row pm-row">
              <span>Softness</span>
              <input type="range" min={0} max={1} step={0.05} value={soft} onChange={(e) => setSoft(Number(e.target.value))} aria-label="Brush softness" />
              <span className="mono">{soft.toFixed(2)}</span>
            </label>
            <div className="pm-group">Pad</div>
            <div className="field-row pm-row">
              <span>Frame</span>
              <select value={ASPECTS.find((x) => Math.abs(x.value - spec.aspect) < 1e-3)?.value ?? spec.aspect} onChange={(e) => setSpec({ ...spec, aspect: Number(e.target.value) })} aria-label="Pad proportions">
                {!ASPECTS.some((x) => Math.abs(x.value - spec.aspect) < 1e-3) && <option value={spec.aspect}>{spec.aspect.toFixed(2)} : 1</option>}
                {ASPECTS.map((x) => (
                  <option key={x.label} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="field-row pm-row">
              <span>Background</span>
              <input type="range" min={0} max={1} step={0.05} value={spec.background} onChange={(e) => setSpec({ ...spec, background: Number(e.target.value) })} aria-label="Background tone" />
              <span className="mono">{spec.background.toFixed(2)}</span>
            </label>
            <div className="btnrow" style={{ padding: '8px 0' }}>
              <button className="btn sm" disabled={!spec.strokes.length} onClick={undoStroke} title="Undo stroke (Ctrl+Z)">
                Undo
              </button>
              <button className="btn sm" disabled={!redo.length} onClick={redoStroke} title="Redo stroke (Ctrl+Shift+Z)">
                Redo
              </button>
              <button
                className="btn sm"
                disabled={!spec.strokes.length}
                onClick={() => {
                  setRedo([]);
                  setSpec({ ...spec, strokes: [] });
                }}
              >
                Clear
              </button>
              <span className="mono" style={{ alignSelf: 'center', color: 'var(--muted)' }}>
                {spec.strokes.length} stroke{spec.strokes.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        </div>
        <div className="btnrow" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--line)' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn default" onClick={() => onApply(spec)}>
            Use drawing
          </button>
        </div>
      </div>
    </div>
  );
}
