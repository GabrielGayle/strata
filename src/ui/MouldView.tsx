import { useStore } from '../state/store';
import { useFullModel, useModel, fmt } from './model';
import { download, mouldPartDxf, mouldStl, shapeSvg } from '../core/exporters';
import { shapeBBox } from '../core/geom2d';
import { fitBox, shapeD } from './svg';
import PourEditor from './PourEditor';
import type { MouldPart } from '../core/mould';

function MouldCard({ mp }: { mp: MouldPart }) {
  const v = useModel().v;
  const bb = shapeBBox(mp.shape);
  const fb = fitBox(bb.minX, bb.minY, bb.maxX, bb.maxY, 0.05);
  return (
    <div className="card" style={{ cursor: 'default' }}>
      <svg viewBox={`${fb.x} ${fb.y} ${fb.w} ${fb.h}`} preserveAspectRatio="xMidYMid meet">
        <path d={shapeD(mp.shape)} fill="#e2c9a0" stroke="var(--svg-cut)" strokeWidth={fb.w / 220} fillRule="evenodd" />
      </svg>
      <span className="cap">
        <span>{mp.id}</span>
        <span>
          {fmt(bb.maxX - bb.minX, 0)}×{fmt(bb.maxY - bb.minY, 0)}
        </span>
      </span>
      <span className="seg">
        <button className="btn sm" onClick={() => download(`${mp.id}.dxf`, mouldPartDxf(mp, v), 'application/dxf')}>
          DXF
        </button>
        <button className="btn sm" onClick={() => download(`${mp.id}.svg`, shapeSvg([{ shape: mp.shape }]), 'image/svg+xml')}>
          SVG
        </button>
      </span>
    </div>
  );
}

export default function MouldView() {
  const model = useModel();
  const fullModel = useFullModel();
  const setUi = useStore((s) => s.setUi);
  const v = model.v;
  const groups: { title: string; body: 'base' | 'insert' }[] = [
    { title: 'Base mould', body: 'base' },
    { title: 'Insert mould', body: 'insert' },
  ];
  return (
    <div className="scroll">
      <div className="pad" style={{ display: 'grid', gap: 12 }}>
        <div className="grid2">
          <div className="window box">
            <div className="title-bar box-head">
              <span>Strata pour plan</span>
              <span className="seg">
                {(['plain', 'layers', 'eroded'] as const).map((m) => (
                  <button key={m} className={`btn sm ${v.pourView === m ? 'on' : ''}`} onClick={() => useStore.getState().setParam('pourView', m)}>
                    {m === 'eroded' ? 'sanded' : m}
                  </button>
                ))}
              </span>
            </div>
            <div style={{ padding: 10 }}>
              <PourEditor />
            </div>
            <div className="note">
              Pour bottom to top into the base mould. Each band's height is an expression, so it follows the base height. Tint each band with pigment; pour the next band while the previous is still
              green so the layers bond. Preview the bands in 3D (and the sanded-back look).
            </div>
            <div className="btnrow">
              <button className="btn sm" onClick={() => setUi({ tab: '3d', snap: { dir: 'side', n: Date.now() } })}>
                View bands in 3D
              </button>
            </div>
          </div>
          <div className="window box">
            <div className="title-bar box-head">
              <span>Mould notes</span>
              <span className="mono" style={{ fontWeight: 400 }}>
                {model.moulds.parts.length} ply parts · {model.bom.dowels} dowels · {model.bom.bolts} clamp bolts
              </span>
            </div>
            {model.moulds.notes.map((n, i) => (
              <div key={i} className="note">
                {n}
              </div>
            ))}
            {!v.mouldOn && <div className="note warn">Mould generation is off (Mould › Generate moulds).</div>}
            <dl className="kv">
              <dt>Plywood</dt>
              <dd>
                {fmt(v.plyThickness, 1)} mm · {fmt(model.bom.plyArea, 2)} m² · {model.bom.plySheets} sheets
              </dd>
              <dt>Wall · draft</dt>
              <dd>
                {fmt(v.mouldWall, 0)} mm · {fmt(v.draft, 1)}°
              </dd>
              <dt>Base concrete</dt>
              <dd>
                {fmt(model.bom.concreteBase, 1)} L
              </dd>
              {model.bom.concreteInsert > 0 && (
                <>
                  <dt>Insert concrete</dt>
                  <dd>{fmt(model.bom.concreteInsert, 1)} L</dd>
                </>
              )}
            </dl>
            <div className="btnrow">
              <button className="btn sm" onClick={() => setUi({ tab: '3d', showMoulds: true, explode: true })}>
                Show moulds in 3D
              </button>
            </div>
          </div>
        </div>
        {groups.map((g) => {
          const parts = model.moulds.parts.filter((p) => p.body === g.body);
          if (!parts.length) return null;
          return (
            <div className="window box" key={g.body}>
              <div className="title-bar box-head">
                <span>
                  {g.title} · {parts.length} parts
                </span>
                <span className="seg">
                  <button
                    className="btn sm"
                    onClick={() => {
                      const stl = mouldStl(fullModel(), g.body);
                      if (stl) download(`${g.body}-mould.stl`, stl, 'model/stl');
                    }}
                  >
                    STL (3D toolpaths)
                  </button>
                </span>
              </div>
              <div className="cards" style={{ borderLeft: 0 }}>
                {parts.map((mp) => (
                  <MouldCard key={mp.id} mp={mp} />
                ))}
              </div>
            </div>
          );
        })}
        <div className="note">
          Rings are CNC-routed from plywood (2D profiles, no kerf offset: let the CAM apply tool-radius compensation). Dowel holes register the layers; tabs take clamps or bolts. Split rings open
          sideways to release the cast. The jig sits on the top layer and holds every plate at its pitch.
        </div>
      </div>
    </div>
  );
}
