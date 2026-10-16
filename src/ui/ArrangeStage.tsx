// One surface's picture with its layers as boxes on top. Drag a box to move it
// (Shift keeps it straight), the red or green arrow to slide it along one axis
// only, the corner to resize and the dot to turn. Centres snap to the middle
// lines and the frame edges (hold Alt to place freely). Shared by the composer
// and the layers on each surface card of the Image tab.
import { useEffect, useRef, useState } from 'react';
import { blockSize, type Block, type Composition, type Surface } from '../core/compose';
import type { Gray } from '../core/image';
import { paintGray } from './surfaces';

type Mode = 'move' | 'x' | 'y' | 'scale' | 'rotate';
type Drag = { id: string; mode: Mode; x0: number; y0: number; b0: Block; rect: DOMRect; ext: { w: number; h: number } };

const SNAP = 0.012;

/** Snap a centre so the block's middle or one of its edges lands on a middle line or frame edge. */
function snap(c: number, half: number): { v: number; guide: number | null } {
  for (const [line, off] of [
    [0.5, 0],
    [0, -half],
    [1, half],
  ] as const) {
    if (Math.abs(c + off - line) < SNAP) return { v: line - off, guide: line };
  }
  return { v: c, guide: null };
}

export default function ArrangeStage({
  comp,
  surface,
  sourceOf,
  preview,
  sel,
  onSelect,
  onChange,
  onBegin,
  onDropBlock,
  compact = false,
  empty = 'No blocks on this surface yet. Add one, or drag one here from the tray.',
}: {
  comp: Composition;
  surface: Surface;
  sourceOf: (b: Block) => Gray | null;
  preview: Gray;
  sel: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Block>) => void;
  onBegin: () => void;
  onDropBlock: (id: string, x: number, y: number) => void;
  compact?: boolean;
  empty?: string;
}) {
  const frame = comp.frames[surface];
  const ref = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  useEffect(() => {
    if (cv.current) paintGray(cv.current, preview);
  }, [preview]);

  const start = (e: React.PointerEvent, b: Block, mode: Mode) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSelect(b.id);
    onBegin();
    const sz = blockSize(b, sourceOf(b) ?? { w: 1, h: 1 }, frame.aspect);
    drag.current = { id: b.id, mode, x0: e.clientX, y0: e.clientY, b0: b, rect: ref.current!.getBoundingClientRect(), ext: sz };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { rect, b0 } = d;
    const cx = rect.left + b0.x * rect.width, cy = rect.top + b0.y * rect.height;
    if (d.mode === 'move' || d.mode === 'x' || d.mode === 'y') {
      let dx = (e.clientX - d.x0) / rect.width, dy = (e.clientY - d.y0) / rect.height;
      // Shift on a free move keeps it straight along whichever way it has gone further
      const lock = d.mode !== 'move' ? d.mode : e.shiftKey ? (Math.abs(e.clientX - d.x0) >= Math.abs(e.clientY - d.y0) ? 'x' : 'y') : null;
      if (lock === 'x') dy = 0;
      if (lock === 'y') dx = 0;
      let x = b0.x + dx, y = b0.y + dy;
      let gx: number | null = null, gy: number | null = null;
      if (!e.altKey) {
        // snap on the unrotated size: close enough for lining things up by eye
        if (lock !== 'y') ({ v: x, guide: gx } = snap(x, d.ext.w / 2));
        if (lock !== 'x') ({ v: y, guide: gy } = snap(y, d.ext.h / 2));
      }
      setGuides({ x: gx, y: gy });
      onChange(d.id, { x: +x.toFixed(4), y: +y.toFixed(4) });
    } else if (d.mode === 'scale') {
      const r0 = Math.hypot(d.x0 - cx, d.y0 - cy), r1 = Math.hypot(e.clientX - cx, e.clientY - cy);
      onChange(d.id, { scale: Math.min(4, Math.max(0.02, (b0.scale * r1) / Math.max(1, r0))) });
    } else {
      const a0 = Math.atan2(d.y0 - cy, d.x0 - cx), a1 = Math.atan2(e.clientY - cy, e.clientX - cx);
      let r = b0.rotate + ((a1 - a0) * 180) / Math.PI;
      r = ((((r + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      onChange(d.id, { rotate: +r.toFixed(1) });
    }
  };
  const end = () => {
    drag.current = null;
    setGuides({ x: null, y: null });
  };
  const handle = (b: Block, mode: Mode) => ({
    onPointerDown: (e: React.PointerEvent) => start(e, b, mode),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  const blocks = comp.blocks.filter((b) => b.surface === surface);
  const selected = blocks.find((b) => b.id === sel);
  return (
    <div className={`cm-stage-wrap ${compact ? 'compact' : ''}`} onPointerDown={() => onSelect(null)}>
      <div
        ref={ref}
        className="cm-stage"
        style={{ aspectRatio: `${preview.w} / ${preview.h}`, ['--fa' as string]: frame.aspect }}
        onDragOver={(e) => e.dataTransfer.types.includes('text/x-block') && e.preventDefault()}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('text/x-block');
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          const r = ref.current!.getBoundingClientRect();
          onDropBlock(id, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        }}
      >
        <canvas ref={cv} />
        {blocks.map((b) => {
          const src = sourceOf(b);
          const sz = blockSize(b, src ?? { w: 1, h: 1 }, frame.aspect);
          const on = b.id === sel;
          return (
            <div
              key={b.id}
              className={`cm-box ${on ? 'on' : ''} ${b.hidden ? 'hidden' : ''}`}
              style={{ left: `${(b.x - sz.w / 2) * 100}%`, top: `${(b.y - sz.h / 2) * 100}%`, width: `${sz.w * 100}%`, height: `${sz.h * 100}%`, transform: `rotate(${b.rotate}deg)` }}
              {...handle(b, 'move')}
              title={`${b.name}: drag to move (Shift keeps it straight)`}
            >
              {on && (
                <>
                  <span className="cm-h cm-scale" {...handle(b, 'scale')} title="Drag to resize" />
                  <span className="cm-h cm-rot" {...handle(b, 'rotate')} title="Drag to turn (Shift snaps to 15°)" />
                  <span className="cm-label">{b.name}</span>
                </>
              )}
            </div>
          );
        })}
        {selected && (
          // the straight mover: drawn upright whatever the block's turn
          <div className="ag" style={{ left: `${selected.x * 100}%`, top: `${selected.y * 100}%` }}>
            <span className="ag-arrow ag-x" {...handle(selected, 'x')} title="Slide left and right only" />
            <span className="ag-arrow ag-y" {...handle(selected, 'y')} title="Slide up and down only" />
            <span className="ag-c" {...handle(selected, 'move')} title="Drag to move freely" />
          </div>
        )}
        {guides.x !== null && <span className="ag-guide v" style={{ left: `${guides.x * 100}%` }} />}
        {guides.y !== null && <span className="ag-guide h" style={{ top: `${guides.y * 100}%` }} />}
        {!blocks.length && <div className="empty cm-empty">{empty}</div>}
      </div>
    </div>
  );
}
