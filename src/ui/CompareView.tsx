import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { useStore } from '../state/store';
import { useAssets } from '../state/assets';
import { createPipeline, type Model } from '../core/pipeline';
import { PARAMS, PARAM_MAP } from '../core/params';
import type { Project } from '../core/project';
import Scene from './Scene';
import { CameraRig } from './Viewport';
import { fmt } from './model';

function MiniView({ model, label }: { model: Model; label: string }) {
  const opts = { selected: null, showMoulds: false, explode: false, xray: false, showIssues: false, showSource: false };
  return (
    <div style={{ position: 'relative', minHeight: 280, borderRight: '1px solid var(--line)', background: 'var(--viewport)' }}>
      <Canvas dpr={[1, 2]} gl={{ antialias: true, alpha: true }} style={{ position: 'absolute', inset: 0 }}>
        <PerspectiveCamera makeDefault fov={32} near={1} far={60000} position={[1500, 1100, 1800]} />
        <OrbitControls makeDefault enableDamping />
        <CameraRig model={model} snap={{ dir: 'iso', n: 0 }} ortho={false} />
        <Scene model={model} opts={opts} />
      </Canvas>
      <div className="overlay tl info">
        <span style={{ fontWeight: 700 }}>{label}</span>
        <span>
          {model.sliced.parts.length} parts · {model.bom.sheets} sheets
        </span>
      </div>
    </div>
  );
}

export default function CompareView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const assets = useAssets(project);
  const pipeA = useMemo(() => createPipeline(), []);
  const pipeB = useMemo(() => createPipeline(), []);
  const resolve = (id: string): { p: Project; name: string } => {
    const v = project.variants.find((x) => x.id === id);
    if (!v) return { p: project, name: 'Current' };
    return { p: { ...project, params: { ...project.params, ...v.params }, pour: v.pour }, name: v.name };
  };
  const A = resolve(ui.compareA);
  const B = resolve(ui.compareB);
  const mA = useMemo(() => pipeA(A.p, assets), [A.p, assets, pipeA]);
  const mB = useMemo(() => pipeB(B.p, assets), [B.p, assets, pipeB]);
  const diffs = PARAMS.filter((d) => String(A.p.params[d.id] ?? d.def) !== String(B.p.params[d.id] ?? d.def));
  const metrics: [string, (m: Model) => number, number, string][] = [
    ['Parts', (m) => m.sliced.parts.length, 0, ''],
    ['Laser sheets', (m) => m.bom.sheets, 0, ''],
    ['Metal mass', (m) => m.bom.plateMass, 1, 'kg'],
    ['Cut length', (m) => m.bom.cutLength, 1, 'm'],
    ['Concrete', (m) => m.bom.concreteBase + m.bom.concreteInsert, 1, 'L'],
    ['Concrete mass', (m) => m.bom.concreteMass, 0, 'kg'],
    ['Plywood sheets', (m) => m.bom.plySheets, 0, ''],
    ['Errors', (m) => m.issues.filter((i) => i.severity === 'error').length, 0, ''],
  ];
  const options = [{ id: 'current', name: 'Current' }, ...project.variants.map((v) => ({ id: v.id, name: v.name }))];
  return (
    <div className="scroll">
      <div className="panel-title">
        <span>
          A{' '}
          <select className="sel" value={ui.compareA} onChange={(e) => setUi({ compareA: e.target.value })} aria-label="Variant A">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </span>
        <span>
          B{' '}
          <select className="sel" value={ui.compareB} onChange={(e) => setUi({ compareB: e.target.value })} aria-label="Variant B">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </span>
      </div>
      {project.variants.length === 0 && <div className="note">Save variants from the toolbar (Variants › Save current) to compare them side by side.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', borderBottom: '1px solid var(--line)', height: '46vh' }}>
        <MiniView model={mA} label={`A · ${A.name}`} />
        <MiniView model={mB} label={`B · ${B.name}`} />
      </div>
      <div className="pad grid2">
        <div className="box">
          <div className="box-head">Outputs</div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">A</th>
                <th className="num">B</th>
                <th className="num">Δ</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([k, f, d, u]) => {
                const a = f(mA), b = f(mB);
                return (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="num">
                      {fmt(a, d)} {u}
                    </td>
                    <td className="num">
                      {fmt(b, d)} {u}
                    </td>
                    <td className="num" style={{ color: b - a ? 'var(--accent)' : 'var(--muted)' }}>
                      {b - a > 0 ? '+' : ''}
                      {fmt(b - a, d)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="box">
          <div className="box-head">Parameters that differ ({diffs.length})</div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>A</th>
                <th>B</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map((d) => (
                <tr key={d.id}>
                  <td title={d.id}>
                    {PARAM_MAP[d.id].label} <span className="mono" style={{ color: 'var(--muted)', fontSize: 10 }}>{d.group}</span>
                  </td>
                  <td className="mono">{String(A.p.params[d.id] ?? d.def)}</td>
                  <td className="mono">{String(B.p.params[d.id] ?? d.def)}</td>
                </tr>
              ))}
              {!diffs.length && (
                <tr>
                  <td colSpan={3} style={{ color: 'var(--muted)' }}>
                    Identical parameters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
