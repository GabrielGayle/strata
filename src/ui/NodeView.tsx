// Node view of the composer: every block is a node with its own adjustments,
// wired into one of the surface outputs (or left in the tray). Drag a node by
// its header to arrange the board; drag from its output dot onto a surface to
// rewire it there.
import { useEffect, useMemo, useRef, useState } from 'react';
import { composite, frameSize, SURFACES, type Block, type BlendMode, type Composition, type Surface } from '../core/compose';
import type { Gray } from '../core/image';
import { paintGray, SURFACE_INFO } from './surfaces';

const NODE_W = 200;
const OUT_W = 190;
const KIND: Record<Block['source']['kind'], string> = { image: 'Image', pattern: 'Pattern', drawing: 'Drawing' };

function Thumb({ g, h = 64 }: { g: Gray | null; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && g) paintGray(ref.current, g);
  }, [g]);
  return <canvas ref={ref} className="nv-thumb" style={{ height: h, aspectRatio: g ? `${g.w} / ${g.h}` : '1' }} />;
}

/** Default spot for a node that has never been moved: down a column, grouped by surface. */
function autoPos(comp: Composition, b: Block, rows: number): { x: number; y: number } {
  const order = (x: Block) => (x.surface === null ? 3 : SURFACES.indexOf(x.surface));
  const free = comp.blocks.filter((x) => !x.node).sort((p, q) => order(p) - order(q));
  const i = Math.max(0, free.findIndex((x) => x.id === b.id));
  return { x: 16 + Math.floor(i / rows) * (NODE_W + 48), y: 16 + (i % rows) * 150 };
}

export default function NodeView({
  comp,
  sourceOf,
  sel,
  onSelect,
  onBegin,
  onChange,
  onWire,
  onOpenSurface,
}: {
  comp: Composition;
  sourceOf: (b: Block) => Gray | null;
  sel: string | null;
  onSelect: (id: string | null) => void;
  onBegin: () => void;
  onChange: (id: string, patch: Partial<Block>) => void;
  onWire: (id: string, s: Surface | null) => void;
  onOpenSurface: (s: Surface) => void;
}) {
  const board = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 520 });
  const [wire, setWire] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<Surface | 'tray' | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = Math.max(2, Math.floor((size.h - 16) / 150));
  const pos = (b: Block) => b.node ?? autoPos(comp, b, rows);
  const outX = Math.max(NODE_W * 2 + 80, size.w - OUT_W - 16);
  const targets: (Surface | 'tray')[] = [...SURFACES, 'tray'];
  const outH = Math.max(120, (size.h - 16 * 5) / 4);
  const outY = (t: Surface | 'tray') => 16 + targets.indexOf(t) * (outH + 16);
  const previews = useMemo(
    () =>
      Object.fromEntries(
        SURFACES.map((s) => {
          const { w, h } = frameSize(comp.frames[s], 160);
          return [s, composite(comp, s, sourceOf, w, h)];
        }),
      ) as Record<Surface, Gray>,
    [comp, sourceOf],
  );

  const local = (e: { clientX: number; clientY: number }) => {
    const r = board.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + board.current!.scrollLeft, y: e.clientY - r.top + board.current!.scrollTop };
  };
  const targetAt = (p: { x: number; y: number }): Surface | 'tray' | null => {
    if (p.x < outX - 20) return null;
    for (const t of targets) if (p.y >= outY(t) && p.y <= outY(t) + outH) return t;
    return null;
  };
  const nodeH = 132;
  const contentH = Math.max(size.h, ...comp.blocks.map((b) => pos(b).y + nodeH + 16));

  return (
    <div
      ref={board}
      className="nv"
      onPointerDown={() => onSelect(null)}
      onPointerMove={(e) => {
        const p = local(e);
        if (drag.current) {
          const d = drag.current;
          onChange(d.id, { node: { x: Math.max(0, Math.min(outX - NODE_W - 30, p.x - d.dx)), y: Math.max(0, p.y - d.dy) } });
        } else if (wire) {
          setWire({ ...wire, ...p });
          setHover(targetAt(p));
        }
      }}
      onPointerUp={(e) => {
        if (wire) {
          const t = targetAt(local(e));
          if (t) onWire(wire.id, t === 'tray' ? null : t);
        }
        drag.current = null;
        setWire(null);
        setHover(null);
      }}
    >
      <svg className="nv-wires" width={size.w} height={contentH} aria-hidden>
        {comp.blocks.map((b) => {
          const p = pos(b);
          const t = b.surface ?? 'tray';
          const x1 = p.x + NODE_W, y1 = p.y + 22;
          const x2 = outX, y2 = outY(t) + 22;
          const k = Math.max(40, (x2 - x1) / 2);
          return <path key={b.id} d={`M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`} className={`nv-wire ${b.id === sel ? 'on' : ''} ${b.hidden ? 'off' : ''} ${wire?.id === b.id ? 'ghost' : ''}`} />;
        })}
        {wire &&
          (() => {
            const b = comp.blocks.find((x) => x.id === wire.id)!;
            const p = pos(b);
            const x1 = p.x + NODE_W, y1 = p.y + 22;
            const k = Math.max(40, (wire.x - x1) / 2);
            return <path d={`M${x1},${y1} C${x1 + k},${y1} ${wire.x - k},${wire.y} ${wire.x},${wire.y}`} className="nv-wire live" />;
          })()}
      </svg>

      {comp.blocks.map((b) => {
        const p = pos(b);
        return (
          <div
            key={b.id}
            className={`nv-node ${b.id === sel ? 'on' : ''} ${b.hidden ? 'hidden' : ''}`}
            style={{ left: p.x, top: p.y, width: NODE_W }}
            onPointerDown={(e) => (e.stopPropagation(), onSelect(b.id))}
            onDoubleClick={() => b.surface && onOpenSurface(b.surface)}
          >
            <div
              className="nv-head"
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(b.id);
                onBegin();
                const q = local(e);
                drag.current = { id: b.id, dx: q.x - p.x, dy: q.y - p.y };
              }}
              title="Drag to arrange"
            >
              <span className="nv-kind">{KIND[b.source.kind]}</span>
              <span className="nv-name">{b.name}</span>
            </div>
            <span
              className="nv-port"
              title="Drag onto a surface to send this block there"
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(b.id);
                setWire({ id: b.id, ...local(e) });
              }}
            />
            <div className="nv-body">
              <Thumb g={sourceOf(b)} h={48} />
              <div className="nv-ops">
                <select
                  value={b.blend}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    onBegin();
                    onChange(b.id, { blend: e.target.value as BlendMode });
                  }}
                  aria-label="Blend"
                >
                  <option value="darken">Darken</option>
                  <option value="multiply">Multiply</option>
                  <option value="lighten">Lighten</option>
                  <option value="normal">Cover</option>
                </select>
                <label onPointerDown={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="chk"
                    checked={b.invert}
                    onChange={(e) => {
                      onBegin();
                      onChange(b.id, { invert: e.target.checked });
                    }}
                  />{' '}
                  Invert
                </label>
                <label onPointerDown={(e) => e.stopPropagation()} title="Strength">
                  <input type="range" min={0} max={1} step={0.01} value={b.opacity} onPointerDown={onBegin} onChange={(e) => onChange(b.id, { opacity: Number(e.target.value) })} aria-label="Strength" />
                </label>
              </div>
            </div>
          </div>
        );
      })}

      {targets.map((t) => {
        const n = comp.blocks.filter((b) => (b.surface ?? 'tray') === t).length;
        return (
          <div
            key={t}
            className={`nv-out ${hover === t ? 'hover' : ''}`}
            style={{ left: outX, top: outY(t), width: OUT_W, height: outH }}
            onDoubleClick={() => t !== 'tray' && onOpenSurface(t)}
            title={t === 'tray' ? 'Blocks wired here sit on no surface' : `Double-click to place blocks on the ${SURFACE_INFO[t].short.toLowerCase()}`}
          >
            <span className="nv-port in" />
            <div className="nv-head">
              <span className="nv-kind">Output</span>
              <span className="nv-name">
                {t === 'tray' ? 'Tray' : SURFACE_INFO[t].short} · {n}
              </span>
            </div>
            {t !== 'tray' && <Thumb g={previews[t]} h={Math.max(40, outH - 44)} />}
          </div>
        );
      })}
      {!comp.blocks.length && <div className="empty" style={{ position: 'absolute', left: 16, top: 16, right: OUT_W + 40 }}>Add an image, pattern or drawing above. It lands in the tray here; wire it into a surface.</div>}
    </div>
  );
}
