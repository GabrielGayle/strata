import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import { GROUPS, PARAMS, PARAM_MAP, FLAG_NAMES } from '../core/params';
import { FUNC_NAMES } from '../core/expr';

const NODE_W = 168;
const NODE_H = 36;
const COL_GAP = 70;
const ROW_GAP = 10;

const STAGE_INPUTS: Record<string, string> = {
  Parameters: 'all expressions',
  'Insert form': 'Insert group, imported mesh',
  'Source form': 'Source form group, imported mesh',
  'Side image': 'side image, contrast, smoothing',
  'Front image': 'front image, contrast, smoothing',
  'Strata field': 'Strata group, image mix, seed',
  'Slice plates': 'Plates, Slicer, forms, strata, images',
  'Postcard shelf': 'card list, arc, unobstructed solver',
  'Sight lines': 'shelf cards, viewing angle, seat',
  'Card visibility': 'shelf cards, viewing angle, cut plates',
  'Fit checks': 'plates, min feature, kerf, sheet, postcard faces',
  'Nest sheets': 'plates, sheet size, spacing',
  Moulds: 'plates, Mould group, insert',
  'Nest plywood': 'mould parts, ply sheet',
  Unfold: 'Unfold group, form',
  'Pour plan': 'pour layers, base',
  'Cut list + BOM': 'everything above',
};

export default function GraphView() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const [showAll, setShowAll] = useState(false);
  const deps = model.ev.deps;

  const layout = useMemo(() => {
    const numeric = PARAMS.filter((p) => p.kind === 'number').map((p) => p.id);
    const used = new Set<string>();
    for (const id of numeric) if (deps[id]?.length) [id, ...deps[id]].forEach((x) => used.add(x));
    const ids = showAll ? numeric : numeric.filter((id) => used.has(id));
    const depth: Record<string, number> = {};
    const d = (id: string, seen = new Set<string>()): number => {
      if (depth[id] !== undefined) return depth[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      const ds = deps[id] ?? [];
      depth[id] = ds.length ? 1 + Math.max(...ds.map((x) => d(x, seen))) : 0;
      return depth[id];
    };
    ids.forEach((id) => d(id));
    const cols: string[][] = [];
    for (const id of ids) (cols[depth[id]] ??= []).push(id);
    const gi = (id: string) => GROUPS.indexOf(PARAM_MAP[id].group as (typeof GROUPS)[number]);
    cols.forEach((c) => c.sort((a, b) => gi(a) - gi(b)));
    const pos: Record<string, { x: number; y: number }> = {};
    cols.forEach((c, ci) => c.forEach((id, ri) => (pos[id] = { x: ci * (NODE_W + COL_GAP), y: ri * (NODE_H + ROW_GAP) })));
    const W = cols.length * (NODE_W + COL_GAP);
    const H = Math.max(...cols.map((c) => c.length), 1) * (NODE_H + ROW_GAP);
    return { ids, pos, W, H };
  }, [deps, showAll]);

  const focus = (id: string) => {
    const g = PARAM_MAP[id].group;
    setUi({ focusParam: id, collapsed: { ...ui.collapsed, [g]: false }, filter: '' });
  };
  const hi = ui.focusParam;
  const hiSet = new Set<string>();
  if (hi) {
    hiSet.add(hi);
    (deps[hi] ?? []).forEach((x) => hiSet.add(x));
    for (const [k, ds] of Object.entries(deps)) if (ds.includes(hi)) hiSet.add(k);
  }

  return (
    <div className="scroll">
      <div className="pad" style={{ display: 'grid', gap: 12 }}>
        <div className="window box">
          <div className="title-bar box-head">
            <span>Regeneration pipeline</span>
            <span className="mono" style={{ fontWeight: 400, textTransform: 'none' }}>
              last change: {model.stages.filter((s) => !s.cached).length} stages rebuilt, {fmt(model.totalMs, 0)} ms
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, padding: 10 }}>
            {model.stages.map((s, i) => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center' }}>
                <div
                  style={{
                    border: '1px solid var(--line)',
                    // rebuilt stages: accent edge on the selection tint, so the text keeps AA contrast whatever the accent
                    borderLeft: !s.cached ? '4px solid var(--accent)' : '1px solid var(--line)',
                    background: !s.cached ? 'var(--sel)' : s.stale ? 'var(--panel-2)' : 'var(--panel)',
                    color: 'var(--ink)',
                    padding: '6px 8px',
                    minWidth: 118,
                    margin: '4px 0',
                  }}
                  title={STAGE_INPUTS[s.name]}
                >
                  <div style={{ fontWeight: 700, fontSize: 12 }}>{s.name}</div>
                  <div className="mono" style={{ fontSize: 10 }}>
                    {s.stale ? 'pending' : s.cached ? 'cached' : 'rebuilt'} · {fmt(s.ms, 0)} ms
                  </div>
                </div>
                {i < model.stages.length - 1 && <div style={{ width: 14, borderTop: '1px solid var(--line)' }} />}
              </div>
            ))}
          </div>
          <div className="note">Orange stages were rebuilt by the last edit. Hover a stage for its inputs. Exports run the same pipeline, so nothing is ever baked.</div>
        </div>

        <div className="window box">
          <div className="title-bar box-head">
            <span>Parameter graph · {layout.ids.length} nodes</span>
            <span className="seg">
              <button className={`btn sm ${!showAll ? 'on' : ''}`} onClick={() => setShowAll(false)}>
                Linked
              </button>
              <button className={`btn sm ${showAll ? 'on' : ''}`} onClick={() => setShowAll(true)}>
                All numbers
              </button>
            </span>
          </div>
          <div style={{ overflow: 'auto', background: 'var(--viewport)' }} tabIndex={0} role="region" aria-label="Parameter graph">
            <svg width={layout.W + 20} height={layout.H + 20} style={{ display: 'block' }}>
              <g transform="translate(10 10)">
                {layout.ids.flatMap((id) =>
                  (deps[id] ?? [])
                    .filter((dd) => layout.pos[dd])
                    .map((dd) => {
                      const a = layout.pos[dd];
                      const b = layout.pos[id];
                      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
                      const on = hi && (id === hi || dd === hi);
                      return (
                        <path
                          key={`${dd}>${id}`}
                          d={`M${x1},${y1} C${x1 + COL_GAP / 2},${y1} ${x2 - COL_GAP / 2},${y2} ${x2},${y2}`}
                          fill="none"
                          stroke={on ? 'var(--accent)' : 'var(--muted)'}
                          strokeWidth={on ? 2 : 1}
                        />
                      );
                    }),
                )}
                {layout.ids.map((id) => {
                  const p = layout.pos[id];
                  const raw = String(project.params[id] ?? PARAM_MAP[id].def);
                  const err = model.ev.errors[id];
                  const dim = hi && !hiSet.has(id);
                  return (
                    <g key={id} transform={`translate(${p.x} ${p.y})`} onClick={() => focus(id)} style={{ cursor: 'pointer' }} opacity={dim ? 0.35 : 1}>
                      <rect width={NODE_W} height={NODE_H} fill={id === hi ? 'var(--sel)' : 'var(--panel)'} stroke={err ? 'var(--err)' : 'var(--line)'} />
                      <text x={6} y={14} fontSize={11} fontWeight={700} fill="var(--ink)" fontFamily="var(--mono)">
                        {id}
                      </text>
                      <text x={6} y={28} fontSize={10} fill="var(--muted)" fontFamily="var(--mono)">
                        {(raw.length > 18 ? raw.slice(0, 17) + '…' : raw) + (deps[id]?.length ? '' : '')}
                      </text>
                      <text x={NODE_W - 6} y={28} fontSize={10} textAnchor="end" fill="var(--ink)" fontFamily="var(--mono)">
                        {fmt(model.v[id], Number.isInteger(model.v[id]) ? 0 : 2)}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
          <div className="note">
            Click a node to find it in the panel. Make a link by pressing ƒ on any parameter and typing an expression, e.g. <span className="mono">pitch = thickness * 2</span> or{' '}
            <span className="mono">plateCount = floor(stackLength / pitch)</span>. Functions: {FUNC_NAMES.join(' ')}. Flags: {FLAG_NAMES.join(', ')}.
          </div>
        </div>
      </div>
    </div>
  );
}
