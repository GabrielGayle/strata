import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { download, unfoldDxf } from '../core/exporters';
import { bboxOf } from '../core/geom2d';
import { PanZoom, fitBox, pathD } from './svg';

export default function UnfoldView() {
  const model = useModel();
  const setParams = useStore((s) => s.setParams);
  const setParam = useStore((s) => s.setParam);
  const u = model.unfolded;
  const v = model.v;
  const all = [...u.pieces, ...u.caps];
  const target = v.unfoldTarget === 'source' ? model.source?.form : model.insert?.form;
  const sliceInstead = () => {
    // re-use the target's shape as the source form, then slice it
    if (!target) return;
    const pre = v.unfoldTarget === 'source' ? 'src' : 'ins';
    const patch: Record<string, string> = { stackSource: 'form' };
    if (pre === 'ins') {
      for (const k of ['Shape', 'X', 'Y', 'Z', 'Rot', 'Length', 'Width', 'Height', 'Taper', 'Sweep', 'Camber', 'Bend', 'Twist', 'Scale']) patch[`src${k}`] = String(v[`ins${k}`]);
      patch.insShape = 'none';
    }
    setParams(patch, 'slice-instead');
  };
  if (!u.ok)
    return (
      <div className="empty">
        <p>{u.message}</p>
        <div className="btnrow" style={{ justifyContent: 'center' }}>
          <button className="btn" onClick={() => setParam('unfoldTarget', v.unfoldTarget === 'insert' ? 'source' : 'insert')}>
            Unroll the {v.unfoldTarget === 'insert' ? 'source form' : 'insert'} instead
          </button>
        </div>
      </div>
    );
  const bb = bboxOf(all.map((p) => p.outline));
  const fb = fitBox(bb.minX, bb.minY, bb.maxX, bb.maxY, 0.06);
  const sw = Math.max(fb.w, fb.h) / 800;
  const bends = u.pieces.flatMap((p) => p.bends);
  return (
    <div className="split" style={{ gridTemplateColumns: '1fr 260px' }}>
      <div className="canvas">
        <div className="svgwrap">
          <PanZoom fit={fb} resetKey={`${all.length}`}>
            {all.map((p) => (
              <g key={p.id}>
                <path d={pathD(p.outline, true)} fill={p.overlaps ? 'color-mix(in srgb, var(--err) 25%, transparent)' : 'var(--svg-fill)'} stroke="var(--svg-cut)" strokeWidth={sw * 1.4} />
                {p.bends.map((b, i) => (
                  <path key={i} d={pathD(b.line)} fill="none" stroke="var(--ok)" strokeWidth={sw * 1.2} strokeDasharray={`${sw * 8} ${sw * 4}`} />
                ))}
                <text x={(bboxOf([p.outline]).minX + bboxOf([p.outline]).maxX) / 2} y={-(bboxOf([p.outline]).minY + bboxOf([p.outline]).maxY) / 2} fontSize={sw * 14} fontFamily="var(--mono)" textAnchor="middle" fill="var(--muted)">
                  {p.id}
                </text>
              </g>
            ))}
          </PanZoom>
          <div className={`overlay tl info`} style={{ pointerEvents: 'auto', maxWidth: 420 }}>
            <span style={{ color: u.developable ? 'var(--ok)' : 'var(--err)', fontWeight: 700 }}>{u.developable ? 'DEVELOPABLE' : 'NOT DEVELOPABLE'}</span>
            <span style={{ whiteSpace: 'normal' }}>{u.message}</span>
          </div>
        </div>
      </div>
      <div className="list sunken-panel" style={{ borderRight: 0, borderLeft: 0 }}>
        <div className="title-bar panel-title">
          <span>Flat pattern</span>
          <button className="btn sm" onClick={() => download('flat-pattern.dxf', unfoldDxf(all, v), 'application/dxf')}>
            DXF
          </button>
        </div>
        <dl className="kv">
          <dt>Unrolling</dt>
          <dd>{v.unfoldTarget}</dd>
          <dt>Mode</dt>
          <dd>{v.unfoldFacets >= 3 ? `${v.unfoldFacets} facets (press brake)` : 'rolled'}</dd>
          <dt>Sheet</dt>
          <dd>{fmt(u.thickness, 1)} mm</dd>
          <dt>Pieces</dt>
          <dd>
            {u.pieces.length} + {u.caps.length} caps
          </dd>
          <dt>Stretch</dt>
          <dd style={{ color: u.developable ? 'var(--ok)' : 'var(--err)' }}>{fmt(u.maxStretch * 100, 2)}%</dd>
        </dl>
        {bends.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Bend</th>
                <th className="num">Angle</th>
                <th className="num">BA</th>
                <th className="num">BD</th>
              </tr>
            </thead>
            <tbody>
              {bends.slice(0, 64).map((b, i) => (
                <tr key={i}>
                  <td className="mono">B{i + 1}</td>
                  <td className="num">{fmt(b.angle, 1)}°</td>
                  <td className="num">{fmt(b.ba, 2)}</td>
                  <td className="num">{fmt(b.bd, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {bends.length > 0 && (
          <div className="note">
            BA = θ·(R + K·T) with R {fmt(v.bendRadius, 1)} mm, K {fmt(v.kFactor, 2)}, T {fmt(u.thickness, 1)} mm. Bend lines are on the BEND layer. The pattern is the developed neutral surface.
          </div>
        )}
        {!u.developable && (
          <div className="btnrow">
            <button className="btn" onClick={sliceInstead}>
              Slice it into plates instead
            </button>
            <button className="btn" onClick={() => setParams({ unfoldFacets: '16', unfoldPieces: '4' }, 'facet')}>
              Try 16 facets × 4 pieces
            </button>
          </div>
        )}
        <div className="note">Cylinders, cones, straight lofts and fins without bend unroll exactly. Domes and bulged or bent forms can't be flattened without stretching.</div>
      </div>
    </div>
  );
}
