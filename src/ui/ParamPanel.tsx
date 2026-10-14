import { memo, useEffect, useRef, useState } from 'react';
import { GROUPS, PARAMS, type ParamDef, type Values } from '../core/params';
import { isLiteral } from '../core/expr';
import { useStore } from '../state/store';
import { useModel } from './model';
import PourEditor from './PourEditor';

function fmtVal(x: number, step = 1): string {
  if (!Number.isFinite(x)) return '–';
  const d = step >= 1 ? (Number.isInteger(x) ? 0 : 2) : Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
  return String(+x.toFixed(d));
}

const NumberParam = memo(function NumberParam({ def, raw, value, error, clamped, locked, focus }: { def: ParamDef; raw: string; value: number; error?: string; clamped?: boolean; locked: boolean; focus: boolean }) {
  const setParam = useStore((s) => s.setParam);
  const toggleLock = useStore((s) => s.toggleLock);
  const literal = isLiteral(raw);
  const [exprMode, setExprMode] = useState(!literal);
  const [text, setText] = useState(raw);
  const editing = useRef(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing.current) setText(raw);
    if (!isLiteral(raw)) setExprMode(true);
  }, [raw]);
  useEffect(() => {
    if (focus) row.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus]);
  const step = def.step ?? 1;
  const commitText = (t: string) => {
    editing.current = false;
    const v = t.trim();
    if (v === '') {
      setText(raw);
      return;
    }
    setParam(def.id, v);
  };
  return (
    <div className={`prow ${focus ? 'focus' : ''}`} ref={row} title={def.help ?? def.id}>
      <div className="plabel">
        <span>{def.label}</span>
        <span className="pid">{def.id}</span>
      </div>
      <div className="ctrls">
        <button className={`ibtn ${exprMode ? 'on' : ''}`} title="Edit as expression (link to other parameters)" onClick={() => setExprMode(!exprMode)} aria-pressed={exprMode}>
          ƒ
        </button>
        <button className={`ibtn ${locked ? 'on' : ''}`} title={locked ? 'Locked: Randomise skips it' : 'Lock (Randomise skips it)'} onClick={() => toggleLock(def.id)} aria-pressed={locked}>
          {locked ? '■' : '□'}
        </button>
      </div>
      <div className="full">
        {exprMode ? (
          <>
            <input
              className={`exprbox ${error ? 'err' : ''}`}
              value={text}
              spellCheck={false}
              onFocus={() => (editing.current = true)}
              onChange={(e) => setText(e.target.value)}
              onBlur={(e) => commitText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  editing.current = false;
                  setText(raw);
                }
              }}
              aria-label={`${def.label} expression`}
            />
            <span className="evald">= {fmtVal(value, step)}</span>
          </>
        ) : (
          <>
            <input
              type="range"
              min={def.min}
              max={def.max}
              step={step}
              value={value}
              disabled={locked}
              onChange={(e) => setParam(def.id, e.target.value)}
              aria-label={def.label}
            />
            <input
              className={`numbox ${error || clamped ? 'err' : ''}`}
              value={editing.current ? text : fmtVal(value, step)}
              onFocus={(e) => {
                editing.current = true;
                setText(fmtVal(value, step));
                e.target.select();
              }}
              onChange={(e) => setText(e.target.value)}
              onBlur={(e) => commitText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
                  const nv = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value + k));
                  setParam(def.id, String(+nv.toFixed(6)));
                  setText(fmtVal(nv, step));
                }
              }}
              aria-label={`${def.label} value`}
            />
          </>
        )}
        <span className="unit">{def.unit}</span>
      </div>
      {error && <div className="perr">{error}</div>}
      {!error && clamped && <div className="perr">Clamped to {def.min}…{def.max}</div>}
    </div>
  );
});

function OtherParam({ def, value }: { def: ParamDef; value: any }) {
  const setParam = useStore((s) => s.setParam);
  return (
    <div className="prow" title={def.help ?? def.id}>
      <div className="plabel">
        <span>{def.label}</span>
      </div>
      <div className="ctrls">
        {def.kind === 'choice' && (
          <select className="sel" value={value} onChange={(e) => setParam(def.id, e.target.value)} aria-label={def.label}>
            {def.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {def.kind === 'toggle' && <input className="chk" type="checkbox" checked={!!value} onChange={(e) => setParam(def.id, e.target.checked)} aria-label={def.label} />}
        {def.kind === 'color' && <input type="color" value={value} onChange={(e) => setParam(def.id, e.target.value)} aria-label={def.label} />}
        {def.kind === 'text' && <input className="inp" style={{ width: 90 }} value={value} onChange={(e) => setParam(def.id, e.target.value)} aria-label={def.label} />}
      </div>
    </div>
  );
}

export default function ParamPanel() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const v: Values = model.v;
  const filter = ui.filter.trim().toLowerCase();
  const visible = (p: ParamDef) => (!p.show || p.show(v)) && (!filter || p.label.toLowerCase().includes(filter) || p.id.toLowerCase().includes(filter));

  return (
    <div>
      <div className="panel-title">
        <span>Parameters</span>
        <span className="pill" title="Every value regenerates everything downstream">live graph</span>
      </div>
      <input className="search" placeholder="Filter parameters…" value={ui.filter} onChange={(e) => setUi({ filter: e.target.value })} aria-label="Filter parameters" />
      {GROUPS.map((g) => {
        const defs = PARAMS.filter((p) => p.group === g && visible(p));
        if (!defs.length && !(g === 'Concrete' && !filter)) return null;
        const open = filter ? true : !ui.collapsed[g];
        const errs = defs.filter((d) => model.ev.errors[d.id]).length;
        return (
          <section className="section" key={g}>
            <button className="section-head" onClick={() => setUi({ collapsed: { ...ui.collapsed, [g]: open } })} aria-expanded={open}>
              <span>
                {open ? '−' : '+'} {g}
              </span>
              <span className="count" style={errs ? { color: 'var(--err)' } : undefined}>
                {errs ? `${errs} err` : defs.length}
              </span>
            </button>
            {open && (
              <div className="section-body">
                {defs.map((d) =>
                  d.kind === 'number' ? (
                    <NumberParam
                      key={d.id}
                      def={d}
                      raw={String(project.params[d.id] ?? d.def)}
                      value={v[d.id]}
                      error={model.ev.errors[d.id]}
                      clamped={model.ev.clamped[d.id]}
                      locked={!!project.locks[d.id]}
                      focus={ui.focusParam === d.id}
                    />
                  ) : (
                    <OtherParam key={d.id} def={d} value={v[d.id]} />
                  ),
                )}
                {g === 'Concrete' && <PourEditor compact />}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
