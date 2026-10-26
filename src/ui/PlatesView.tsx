import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt, fmtInt } from './model';
import { PanZoom, fitBox, pathD, shapeD } from './svg';
import { fitShape, download, partDxf, shapeSvg } from '../core/exporters';
import { countArcs } from '../core/arcs';
import type { Part } from '../core/slicer';
import { embedOf } from '../core/slicer';
import { laceLink } from '../core/lace';
import { asCut } from './TuningTable';
import { playModes, playStrike } from './audio';
import { heardPartials } from './TuningTable';

function Thumb({ part }: { part: Part }) {
  const bb = part.bbox;
  const fb = fitBox(bb.minX, bb.minY, bb.maxX, bb.maxY, 0.04);
  return (
    <svg viewBox={`${fb.x} ${fb.y} ${fb.w} ${fb.h}`} preserveAspectRatio="xMidYMid meet">
      <path d={shapeD(part.shape)} fill="var(--svg-fill)" stroke="var(--svg-cut)" strokeWidth={fb.w / 160} fillRule="evenodd" />
    </svg>
  );
}

function Detail({ part }: { part: Part }) {
  const model = useModel();
  const v = model.v;
  const [showFit, setShowFit] = useState(true);
  const [showKerf, setShowKerf] = useState(false);
  const plateIdx = model.sliced.plates.findIndex((p) => p.def.key === part.plateKey);
  const plate = model.sliced.plates[plateIdx];
  const tune = model.sliced.tuning?.[plateIdx] ?? null;
  const lace = useStore((s) => s.project.lace);
  const laceHref = lace && v.stackSource === 'lace' && (plate?.def.family === 'P' || plate?.def.family === 'R') ? laceLink(lace, plate.def.index) : '';
  const issues = model.issues.filter((i) => i.partId === part.id || (i.plateKey === part.plateKey && i.type === 'collision'));
  const fitted = useMemo(() => (showFit || showKerf ? fitShape(part.shape, v) : null), [part, v.kerf, v.arcTolerance, showFit, showKerf]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const f = fitShape(part.shape, v);
    return f.reduce((a, c) => {
      const k = countArcs(c.segs);
      return { lines: a.lines + k.lines, arcs: a.arcs + k.arcs };
    }, { lines: 0, arcs: 0 });
  }, [part, v.kerf, v.arcTolerance]); // eslint-disable-line react-hooks/exhaustive-deps
  const bb = part.bbox;
  const fb = fitBox(bb.minX, bb.minY, bb.maxX, bb.maxY, 0.12);
  const sw = Math.max(fb.w, fb.h) / 700;
  // the support ring is drawn in plan, so it has no concrete line
  const e = part.family === 'S' || part.family === 'B' ? 0 : embedOf(v);
  return (
    <>
      <div className="svgwrap">
        <PanZoom fit={fb} resetKey={part.id}>
          {e > 0 && <rect x={bb.minX - 20} y={0} width={bb.maxX - bb.minX + 40} height={e + 10} fill="var(--line-soft)" opacity={0.35} />}
          <path d={shapeD(part.shape)} fill="var(--svg-fill)" stroke="var(--svg-cut)" strokeWidth={sw * 1.4} fillRule="evenodd" />
          {e > 0 && <line x1={bb.minX - 20} x2={bb.maxX + 20} y1={0} y2={0} stroke="var(--muted)" strokeWidth={sw} strokeDasharray={`${sw * 6} ${sw * 4}`} />}
          {plate && plate.sweptInsert.length > 0 && <path d={shapeD(plate.sweptInsert)} fill="none" stroke="var(--info)" strokeWidth={sw} strokeDasharray={`${sw * 2} ${sw * 3}`} fillRule="evenodd" />}
          {plate && plate.cavity.length > 0 && <path d={shapeD(plate.cavity)} fill="none" stroke="var(--accent)" strokeWidth={sw * 1.2} strokeDasharray={`${sw * 6} ${sw * 3}`} fillRule="evenodd" />}
          {[...part.etch, ...part.labelPaths].map((p, i) => (
            <path key={i} d={pathD(p)} fill="none" stroke="var(--svg-etch)" strokeWidth={sw} />
          ))}
          {showKerf && fitted && (
            <g>
              {fitted.map((c, i) => (
                <path key={i} d={pathD(c.segs.map((s) => s.a), true)} fill="none" stroke="var(--err)" strokeWidth={sw * 0.8} strokeDasharray={`${sw * 3} ${sw * 2}`} />
              ))}
            </g>
          )}
          {showFit && fitted && (
            <g>
              {fitted.flatMap((c, ci) =>
                c.segs.map((s, si) =>
                  s.kind === 'line' ? (
                    <line key={`${ci}-${si}`} x1={s.a[0]} y1={-s.a[1]} x2={s.b[0]} y2={-s.b[1]} stroke="var(--ink)" strokeWidth={sw * 1.6} />
                  ) : (
                    <path
                      key={`${ci}-${si}`}
                      d={`M${s.a[0]},${-s.a[1]} A${s.r},${s.r} 0 ${Math.abs(s.sweep) > Math.PI ? 1 : 0} ${s.sweep > 0 ? 0 : 1} ${s.b[0]},${-s.b[1]}`}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={sw * 2}
                    />
                  ),
                ),
              )}
              {fitted.flatMap((c, ci) => c.segs.map((s, si) => <rect key={`n${ci}-${si}`} x={s.a[0] - sw * 2} y={-s.a[1] - sw * 2} width={sw * 4} height={sw * 4} fill="var(--panel)" stroke="var(--ink)" strokeWidth={sw * 0.6} />))}
            </g>
          )}
          {issues.map((i, k) =>
            i.region ? (
              <path key={`r${k}`} d={shapeD(i.region)} fill="var(--err)" opacity={0.55} />
            ) : null,
          )}
          {issues.map((i, k) =>
            i.at ? (
              <rect key={`m${k}`} x={i.at[0] - sw * 7} y={-i.at[1] - sw * 7} width={sw * 14} height={sw * 14} fill="none" stroke={i.severity === 'error' ? 'var(--err)' : 'var(--warn)'} strokeWidth={sw * 2} />
            ) : null,
          )}
          {/* dimensions */}
          <g fontFamily="var(--mono)" fontSize={sw * 11} fill="var(--muted)">
            <text x={(bb.minX + bb.maxX) / 2} y={-bb.maxY - sw * 10} textAnchor="middle">
              {fmt(bb.maxX - bb.minX, 1)} mm
            </text>
            <text x={bb.maxX + sw * 10} y={-(bb.minY + bb.maxY) / 2} textAnchor="start">
              {fmt(bb.maxY - bb.minY, 1)} mm
            </text>
            {e > 0 && (
              <text x={bb.minX - sw * 8} y={-sw * 4} textAnchor="end">
                concrete
              </text>
            )}
          </g>
        </PanZoom>
        <div className="overlay tl">
          <button className={`btn sm ${showFit ? 'on' : ''}`} onClick={() => setShowFit(!showFit)} title="The exact DXF cut geometry: black lines, orange arcs">
            DXF lines + arcs
          </button>
          <button className={`btn sm ${showKerf ? 'on' : ''}`} onClick={() => setShowKerf(!showKerf)}>
            Kerf path
          </button>
          {laceHref && (
            <a className="btn sm" data-hl="open-in-lace" href={laceHref} target="_blank" rel="noopener" title={`Open ${lace!.plates[plate!.def.index].name} in lace, to change its drawing`}>
              Open in lace
            </a>
          )}
        </div>
        <div className="overlay tr info">
          <span className="legend">
            <i style={{ background: 'var(--svg-fill)' }} /> plate {fmt(v.thickness, 1)} mm
          </span>
          <span className="legend">
            <i style={{ borderColor: 'var(--accent)', borderStyle: 'dashed' }} /> cavity (+clearance)
          </span>
          <span className="legend">
            <i style={{ borderColor: 'var(--info)', borderStyle: 'dotted' }} /> insert, true section
          </span>
          <span className="legend">
            <i style={{ background: 'var(--svg-etch)' }} /> etch
          </span>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)', display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <dl className="kv" style={{ flex: '1 1 260px', margin: 0 }}>
          <dt>Part</dt>
          <dd>{part.id}</dd>
          <dt>Size</dt>
          <dd>
            {fmt(bb.maxX - bb.minX, 2)} × {fmt(bb.maxY - bb.minY, 2)} mm
          </dd>
          <dt>Area · cut</dt>
          <dd>
            {fmtInt(part.area)} mm² · {fmt(part.perimeter / 1000, 2)} m
          </dd>
          <dt>DXF entities</dt>
          <dd>
            {counts.lines} lines · {counts.arcs} arcs
          </dd>
          {plate && plate.bevel > 0.01 && (
            <>
              <dt>Bevel avoided</dt>
              <dd>{fmt(plate.bevel, 2)} mm</dd>
            </>
          )}
        </dl>
        {tune && (
          <div className="note" style={{ flex: '1 1 200px', borderLeft: '1px solid var(--line-soft)' }}>
            {tune.model === 'free' ? (
              <>
                Tuned to <b className="mono">{tune.label ?? tune.name}</b> ({fmt(tune.hz, 1)} Hz). Bar length {fmt(tune.cut, 1)} mm, ringing about <span className="mono">{asCut(tune)}</span>.
                {tune.nodes && <> Mounting holes at {tune.nodes.map((s) => `${(s * 100).toFixed(1)}%`).join(' and ')} of the length.</>}
                {tune.partials && <> Overtones {tune.partials.slice(1, 3).map((f) => `${fmt(f, 0)} Hz`).join(' · ')}.</>}{' '}
                <button className="btn sm" onClick={() => playModes(heardPartials(tune, model.sounding?.find((s) => s.key === plate?.def.key), model.stale))} aria-label={`Play ${tune.label ?? tune.name}`}>
                  ▶ Hear it
                </button>
              </>
            ) : (
              <>
                Tuned to <b className="mono">{tune.name}</b> ({fmt(tune.hz, 1)} Hz): {fmt(tune.length, 1)} mm above the concrete, cut at {fmt(tune.cut, 1)} mm so it rings about{' '}
                <span className="mono">{asCut(tune)}</span> before trimming. A prediction only: tune by ear or with a tuner.{' '}
                <button className="btn sm" onClick={() => playStrike(tune.hz)} aria-label={`Play ${tune.name}`}>
                  ▶ Hear it
                </button>
              </>
            )}
          </div>
        )}
        <div style={{ flex: '1 1 260px', borderLeft: '1px solid var(--line-soft)', maxHeight: 130, overflow: 'auto' }}>
          {issues.length === 0 ? (
            <div className="note ok">✓ Laser-ready: no issues on this part.</div>
          ) : (
            issues.map((i, k) => (
              <div key={k} className="issue" style={{ cursor: 'default' }}>
                <span className={`dot ${i.severity}`} />
                <span>{i.message}</span>
              </div>
            ))
          )}
        </div>
        <div className="btnrow" style={{ flexDirection: 'column', borderLeft: '1px solid var(--line-soft)' }}>
          <button className="btn sm" onClick={() => download(`${part.id}.dxf`, partDxf(part, v), 'application/dxf')}>
            Download DXF
          </button>
          <button className="btn sm" onClick={() => download(`${part.id}.svg`, shapeSvg([{ shape: part.shape, etch: [...part.etch, ...part.labelPaths] }]), 'image/svg+xml')}>
            Download SVG
          </button>
        </div>
      </div>
    </>
  );
}

export default function PlatesView() {
  const model = useModel();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const [mode, setMode] = useState<'detail' | 'sheet'>('detail');
  const parts = model.sliced.parts;
  const issueCount = useMemo(() => {
    const m = new Map<string, { e: number; w: number }>();
    for (const i of model.issues) {
      if (!i.partId || i.severity === 'info') continue;
      const c = m.get(i.partId) ?? { e: 0, w: 0 };
      if (i.severity === 'error') c.e++;
      else if (i.severity === 'warn') c.w++;
      m.set(i.partId, c);
    }
    return m;
  }, [model.issues]);
  const tuneOf = useMemo(() => {
    const t = model.sliced.tuning;
    if (!t) return null;
    return new Map(model.sliced.plates.map((p, i) => [p.def.key, t[i]]).filter(([, x]) => x) as [string, NonNullable<(typeof t)[number]>][]);
  }, [model.sliced]);
  const selIdx = Math.max(0, parts.findIndex((p) => p.id === ui.selected));
  const part = parts[selIdx];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        const n = parts[Math.min(parts.length - 1, Math.max(0, selIdx + d))];
        if (n) {
          e.preventDefault();
          setUi({ selected: n.id });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parts, selIdx, setUi]);

  if (!parts.length) return <div className="empty">No plates. Check the slicer settings or the source form.</div>;
  return (
    <div className="split">
      <div className="list sunken-panel">
        <div className="title-bar panel-title">
          <span data-testid="plates-list-count">
            {model.bom.plateCount} plates · {parts.length} parts
          </span>
          <span className="seg">
            <button className={`btn sm ${mode === 'detail' ? 'on' : ''}`} onClick={() => setMode('detail')}>
              Detail
            </button>
            <button className={`btn sm ${mode === 'sheet' ? 'on' : ''}`} onClick={() => setMode('sheet')}>
              All
            </button>
          </span>
        </div>
        <table className="tbl interactive">
          <thead>
            <tr>
              <th>Part</th>
              <th className="num">W × H</th>
              {tuneOf && <th>Note</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => {
              const c = issueCount.get(p.id);
              return (
                <tr key={p.id} className={`click ${p.id === part?.id ? 'sel highlighted' : ''}`} onClick={() => setUi({ selected: p.id })}>
                  <td className="mono">
                    {p.id}
                    {p.plateId && p.plateId !== p.id ? <small style={{ display: 'block', color: 'var(--muted)' }}>part of {p.plateId}</small> : null}
                  </td>
                  <td className="num">
                    {fmt(p.bbox.maxX - p.bbox.minX, 0)}×{fmt(p.bbox.maxY - p.bbox.minY, 0)}
                  </td>
                  {tuneOf && <td className="mono">{tuneOf.get(p.plateKey)?.label ?? tuneOf.get(p.plateKey)?.name ?? ''}</td>}
                  <td>{c ? <span className={`dot ${c.e ? 'error' : 'warn'}`} style={{ display: 'inline-block', width: 9, height: 9, border: '1px solid var(--line)' }} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="canvas">
        {mode === 'detail' && part ? (
          <Detail part={part} />
        ) : (
          <div className="scroll">
            <div className="cards">
              {parts.map((p) => (
                <button
                  key={p.id}
                  className={`card ${p.id === part?.id ? 'sel' : ''}`}
                  onClick={() => {
                    setUi({ selected: p.id });
                    setMode('detail');
                  }}
                >
                  <Thumb part={p} />
                  <span className="cap">
                    <span>{p.id}</span>
                    <span>{issueCount.get(p.id)?.e ? '✕' : issueCount.get(p.id)?.w ? '!' : '✓'}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
