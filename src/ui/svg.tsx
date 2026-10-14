import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Path, Shape } from '../core/geom2d';
import type { Seg } from '../core/arcs';

/** SVG path data for a shape, flipping Y so +Y points up on screen. */
export function shapeD(shape: Shape): string {
  return shape.map((e) => [e.outer, ...e.holes].map((p) => pathD(p, true)).join('')).join('');
}
export function pathD(p: Path, close = false): string {
  if (!p.length) return '';
  let s = `M${p[0][0].toFixed(2)},${(-p[0][1]).toFixed(2)}`;
  for (let i = 1; i < p.length; i++) s += `L${p[i][0].toFixed(2)},${(-p[i][1]).toFixed(2)}`;
  return close ? s + 'Z' : s;
}

export interface VB {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pan (drag) and zoom (wheel / pinch) an SVG viewBox. Coordinates are mm, Y flipped. */
export function PanZoom({ fit, children, resetKey }: { fit: VB; children: ReactNode; resetKey?: string }) {
  const [vb, setVb] = useState<VB>(fit);
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vb: VB } | null>(null);
  const fitKey = `${resetKey}:${fit.x.toFixed(1)}:${fit.y.toFixed(1)}:${fit.w.toFixed(1)}:${fit.h.toFixed(1)}`;
  useEffect(() => setVb(fit), [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setVb((cur) => {
        const k = Math.exp(e.deltaY * 0.0015);
        // keep the point under the cursor fixed (respecting preserveAspectRatio meet)
        const scale = Math.max(cur.w / r.width, cur.h / r.height);
        const ox = (r.width * scale - cur.w) / 2;
        const oy = (r.height * scale - cur.h) / 2;
        const mx = cur.x - ox + (e.clientX - r.left) * scale;
        const my = cur.y - oy + (e.clientY - r.top) * scale;
        return { x: mx - (mx - cur.x) * k, y: my - (my - cur.y) * k, w: cur.w * k, h: cur.h * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <svg
      ref={ref}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, vb };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        const scale = Math.max(d.vb.w / r.width, d.vb.h / r.height);
        setVb({ ...d.vb, x: d.vb.x - (e.clientX - d.x) * scale, y: d.vb.y - (e.clientY - d.y) * scale });
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setVb(fit)}
    >
      {children}
    </svg>
  );
}

export function fitBox(minX: number, minY: number, maxX: number, maxY: number, pad = 0.08): VB {
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const p = Math.max(w, h) * pad;
  return { x: minX - p, y: -maxY - p, w: w + 2 * p, h: h + 2 * p };
}

/** SVG path data for fitted DXF segments (true arcs), Y flipped like shapeD. */
export function segsD(contours: { segs: Seg[] }[]): string {
  let d = '';
  for (const c of contours) {
    if (!c.segs.length) continue;
    const s0 = c.segs[0];
    d += `M${s0.a[0].toFixed(3)},${(-s0.a[1]).toFixed(3)}`;
    for (const s of c.segs) {
      if (s.kind === 'line') d += `L${s.b[0].toFixed(3)},${(-s.b[1]).toFixed(3)}`;
      else d += `A${s.r.toFixed(3)},${s.r.toFixed(3)} 0 ${Math.abs(s.sweep) > Math.PI ? 1 : 0} ${s.sweep > 0 ? 0 : 1} ${s.b[0].toFixed(3)},${(-s.b[1]).toFixed(3)}`;
    }
    d += 'Z';
  }
  return d;
}
