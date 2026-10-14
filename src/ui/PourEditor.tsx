import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import type { PourLayer } from '../core/mould';

const PALETTE = ['#9c4a2e', '#d08b5b', '#e8d6bb', '#b5653a', '#7d3b25', '#c9a27a', '#efe4d2'];

export default function PourEditor({ compact = false }: { compact?: boolean }) {
  const pour = useStore((s) => s.project.pour);
  const setPour = useStore((s) => s.setPour);
  const model = useModel();
  const rows = model.pour.rows;
  const upd = (i: number, patch: Partial<PourLayer>) => setPour(pour.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= pour.length) return;
    const next = [...pour];
    [next[i], next[j]] = [next[j], next[i]];
    setPour(next);
  };
  const add = () =>
    setPour([...pour, { id: `p${Date.now().toString(36)}`, name: `Band ${pour.length + 1}`, height: '20', color: PALETTE[pour.length % PALETTE.length] }]);
  const mismatch = model.pour.mismatch;
  return (
    <div style={{ padding: compact ? '4px 10px 8px' : 0 }}>
      {compact && (
        <div className="plabel" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', margin: '6px 0 4px' }}>
          Strata pour layers (bottom → top)
        </div>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th />
            <th>Layer</th>
            <th>Height (expr)</th>
            <th className="num">mm</th>
            {!compact && <th className="num">Litres</th>}
            {!compact && <th className="num">kg</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {pour.map((p, i) => {
            const r = rows[i];
            return (
              <tr key={p.id}>
                <td>
                  <input type="color" value={p.color} onChange={(e) => upd(i, { color: e.target.value })} aria-label={`${p.name} colour`} style={{ width: 26 }} />
                </td>
                <td>
                  <input className="inp" style={{ width: compact ? 70 : 140 }} value={p.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label="Layer name" />
                </td>
                <td>
                  <input
                    className={`exprbox ${r?.error ? 'err' : ''}`}
                    style={{ width: compact ? 92 : 180 }}
                    value={p.height}
                    onChange={(e) => upd(i, { height: e.target.value })}
                    spellCheck={false}
                    aria-label="Layer height expression"
                  />
                </td>
                <td className="num">{r ? fmt(r.height, 1) : ''}</td>
                {!compact && <td className="num">{r ? fmt(r.volume, 1) : ''}</td>}
                {!compact && <td className="num">{r ? fmt(r.mass, 1) : ''}</td>}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="ibtn" onClick={() => move(i, -1)} aria-label="Move down" title="Lower">
                    ↓
                  </button>
                  <button className="ibtn" onClick={() => move(i, 1)} aria-label="Move up" title="Higher">
                    ↑
                  </button>
                  <button className="ibtn" onClick={() => setPour(pour.filter((_, k) => k !== i))} aria-label="Remove layer">
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 8 }}>
        <button className="btn sm" onClick={add}>
          + Layer
        </button>
        <span className="evald" style={{ color: Math.abs(mismatch) > 0.01 ? 'var(--err)' : 'var(--ok)' }}>
          total {fmt(model.pour.total, 1)} / {fmt(model.v.baseHeight, 0)} mm
        </span>
      </div>
    </div>
  );
}
