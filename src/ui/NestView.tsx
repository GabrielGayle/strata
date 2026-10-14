import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { useFullModel, useModel, fmt } from './model';
import { download, fitShape, mouldPartDxf, sheetDxf } from '../core/exporters';
import { shapeD, pathD, segsD } from './svg';
import type { Shape, Path } from '../core/geom2d';
import type { NestResult } from '../core/nest';
import { zipSync, strToU8 } from 'fflate';

interface Item {
  id: string;
  shape: Shape;
  /** The exact cut path written to the DXF (kerf-compensated lines + arcs), when available. */
  cutD?: string;
  etch: Path[];
  bb: { minX: number; minY: number; maxX: number; maxY: number };
}

function SheetSvg({ nest, index, items, selected, onSelect, color }: { nest: NestResult; index: number; items: Map<string, Item>; selected: string | null; onSelect: (id: string) => void; color: string }) {
  const s = nest.sheets[index];
  const W = nest.sheetW;
  const H = nest.sheetH;
  const sw = W / 900;
  return (
    <svg viewBox={`${-W * 0.01} ${-H * 1.01} ${W * 1.02} ${H * 1.02}`} style={{ width: '100%', display: 'block', background: 'var(--panel)' }}>
      <rect x={0} y={-H} width={W} height={H} fill="var(--panel-2)" stroke="var(--line)" strokeWidth={sw * 1.5} />
      {s.placements.map((pl) => {
        const it = items.get(pl.id);
        if (!it) return null;
        const h = it.bb.maxY - it.bb.minY;
        // part-local → sheet: translate bbox min to placement, optional 90° CCW rotation
        const tf = pl.rot
          ? `translate(${pl.x + h} ${-pl.y}) rotate(-90) translate(${-it.bb.minX} ${it.bb.minY})`
          : `translate(${pl.x - it.bb.minX} ${-pl.y + it.bb.minY})`;
        const sel = selected === pl.id;
        return (
          <g key={pl.id} transform={tf} onClick={() => onSelect(pl.id)} style={{ cursor: 'pointer' }}>
            <path d={it.cutD ?? shapeD(it.shape)} fill={sel ? 'var(--sel)' : color} stroke={sel ? 'var(--accent)' : 'var(--svg-cut)'} strokeWidth={sw * (sel ? 2.2 : 1)} fillRule="evenodd" />
            {it.etch.map((p, k) => (
              <path key={k} d={pathD(p)} fill="none" stroke="var(--svg-etch)" strokeWidth={sw * 0.8} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export default function NestView() {
  const model = useModel();
  const fullModel = useFullModel();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const [which, setWhich] = useState<'metal' | 'ply'>('metal');
  const v = model.v;
  // draw what the sheet DXF actually contains, so the preview can't drift from the file
  const metalItems = useMemo(
    () => new Map<string, Item>(model.sliced.parts.map((p) => [p.id, { id: p.id, shape: p.shape, cutD: segsD(fitShape(p.shape, v)), etch: p.labelPaths, bb: p.bbox }])),
    [model.sliced.parts, v.kerf, v.arcTolerance], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const plyItems = useMemo(() => new Map<string, Item>(
    model.moulds.parts.map((p) => {
      const pts = p.shape[0].outer;
      const bb = pts.reduce((a, [x, y]) => ({ minX: Math.min(a.minX, x), minY: Math.min(a.minY, y), maxX: Math.max(a.maxX, x), maxY: Math.max(a.maxY, y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      return [p.id, { id: p.id, shape: p.shape, etch: [], bb }];
    }),
  ), [model.moulds.parts]);
  const nest = which === 'metal' ? model.nested : model.mouldNest;
  const items = which === 'metal' ? metalItems : plyItems;
  return (
    <div className="scroll">
      <div className="panel-title">
        <span className="seg">
          <button className={`btn sm ${which === 'metal' ? 'on' : ''}`} onClick={() => setWhich('metal')}>
            Laser sheets ({model.nested.sheets.length})
          </button>
          <button className={`btn sm ${which === 'ply' ? 'on' : ''}`} onClick={() => setWhich('ply')}>
            Plywood ({model.mouldNest.sheets.length})
          </button>
        </span>
        <span className="mono" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          {fmt(nest.sheetW, 0)} × {fmt(nest.sheetH, 0)} mm · {fmt(nest.utilisation * 100, 0)}% used
          {model.stale && ' · updating'}
        </span>
        {which === 'metal' ? (
          <button
            className="btn sm"
            onClick={() => {
              const m = fullModel();
              const files: Record<string, Uint8Array> = {};
              m.nested.sheets.forEach((s, i) => (files[`sheet-${String(i + 1).padStart(2, '0')}.dxf`] = strToU8(sheetDxf(m, s.index))));
              download('sheets.zip', zipSync(files), 'application/zip');
            }}
          >
            All sheet DXFs
          </button>
        ) : (
          <button
            className="btn sm"
            onClick={() => {
              const m = fullModel();
              const files: Record<string, Uint8Array> = {};
              for (const mp of m.moulds.parts) files[`${mp.id}.dxf`] = strToU8(mouldPartDxf(mp, m.v));
              download('mould-parts.zip', zipSync(files), 'application/zip');
            }}
          >
            Mould DXFs
          </button>
        )}
      </div>
      {nest.unplaced.length > 0 && <div className="note err">Too big for the sheet: {nest.unplaced.join(', ')}</div>}
      <div className="pad" style={{ display: 'grid', gap: 12 }}>
        {nest.sheets.map((s, i) => (
          <div className="box" key={i}>
            <div className="box-head">
              <span>
                Sheet {i + 1} · {s.placements.length} parts · {fmt((s.used / (nest.sheetW * nest.sheetH)) * 100, 0)}%
              </span>
              {which === 'metal' && (
                <button className="btn sm" onClick={() => download(`sheet-${i + 1}.dxf`, sheetDxf(fullModel(), i), 'application/dxf')}>
                  DXF
                </button>
              )}
            </div>
            <SheetSvg nest={nest} index={i} items={items} selected={ui.selected} onSelect={(id) => setUi({ selected: id })} color={which === 'metal' ? 'var(--svg-fill)' : '#e2c9a0'} />
          </div>
        ))}
        {!nest.sheets.length && <div className="empty">Nothing to nest.</div>}
        <div className="note">
          Shown exactly as written to the DXF (kerf-compensated lines and arcs). Skyline bottom-left nesting of part bounding boxes with {fmt(which === 'metal' ? v.partSpacing : Math.max(v.partSpacing, 8), 0)} mm spacing; parts may rotate 90°. Sheet DXFs carry each part's number on
          the ETCH layer and the sheet outline on SHEET.
        </div>
      </div>
    </div>
  );
}
