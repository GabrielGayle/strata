import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { GROUPS, GROUP_IDLE, GROUP_SWITCHES, PARAMS, PARAM_MAP, SWITCH_IDS, overrideSource, scaleFactorFor, type ParamDef, type Values } from '../core/params';
import TuningTable from './TuningTable';
import { isLiteral } from '../core/expr';
import { useStore } from '../state/store';
import { useModel } from './model';
import PourEditor from './PourEditor';
import CandleMasterInfo from './CandleMasterInfo';
import { changedByGroup, resetGroupPatch } from '../core/paramDiff';
import RoundPreview, { ROUND_PREVIEW_IDS } from './RoundPreview';
import {
  MASTER_PRESET_OPTIONS,
  masterSizePresetPatch,
  type MasterOrientation,
  type MasterPresetId,
} from '../core/masterPresets';
import { SavesPanel } from './LibraryPanel';

function fmtVal(x: number, step = 1): string {
  if (!Number.isFinite(x)) return '–';
  const d = step >= 1 ? (Number.isInteger(x) ? 0 : 2) : Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
  return String(+x.toFixed(d));
}

const NumberParam = memo(function NumberParam({
  def,
  raw,
  value,
  error,
  clamped,
  locked,
  focus,
  factor,
  override,
  overrideBy,
}: {
  def: ParamDef;
  raw: string;
  value: number;
  error?: string;
  clamped?: boolean;
  locked: boolean;
  focus: boolean;
  /** Master size multiplier on this literal; shown values are scaled, stored ones are not. */
  factor: number;
  /** Expression imposed by "Fit face to image" or a fixed plate gap (read-only while active). */
  override?: string;
  overrideBy?: 'spacing' | 'grid' | 'image';
}) {
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
  // the rounding sliders open a close-up while they are being adjusted, and a moment after
  const previews = ROUND_PREVIEW_IDS.has(def.id);
  const [peek, setPeek] = useState(false);
  const [keep, setKeep] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const poke = () => {
    if (!previews) return;
    setPeek(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!holding.current) setPeek(false);
    }, 3000);
  };
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);
  const step = def.step ?? 1;
  // literals are stored at Master size 1, so what you type is what you see at the current size
  const store = (shown: number) => setParam(def.id, String(+(shown / factor).toFixed(6)));
  const commitText = (t: string) => {
    editing.current = false;
    const v = t.trim();
    if (v === '') {
      setText(raw);
      return;
    }
    if (isLiteral(v) && factor !== 1) store(parseFloat(v));
    else setParam(def.id, v);
  };
  if (override) {
    const src = overrideBy ?? overrideSource(def.id);
    const by = src === 'spacing' ? 'Plates › Spacing' : src === 'grid' ? 'Slicer › Closed grid' : 'Image › Fit face to image';
    return (
      <div className={`prow field-row-stacked ${focus ? 'focus' : ''}`} ref={row} title={def.help ?? def.id} data-param={def.id}>
        <div className="field-row">
          <div className="plabel">
            <span>{def.label}</span>
            <span className="pid">{def.id}</span>
          </div>
          <div className="ctrls">
            <span className="pill" title={`Set by ${by}`}>{src === 'spacing' ? 'fixed gap' : src === 'grid' ? 'closed grid' : 'image fit'}</span>
          </div>
        </div>
        <div className="field-row">
          <input className="exprbox" value={override} readOnly aria-label={`${def.label} (set by ${by})`} />
          <span className="evald">= {fmtVal(value, step)}</span>
          <span className="unit">{def.unit}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`prow field-row-stacked ${focus ? 'focus' : ''}`} ref={row} title={def.help ?? def.id} data-param={def.id}>
      <div className="field-row">
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
      </div>
      <div className="field-row">
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
              onPointerDown={() => {
                holding.current = true;
                poke();
              }}
              onPointerUp={() => {
                holding.current = false;
                poke();
              }}
              onChange={(e) => {
                poke();
                if (factor !== 1) store(Number(e.target.value));
                else setParam(def.id, e.target.value);
              }}
              aria-label={def.label}
            />
            <input
              className={`numbox ${error || clamped ? 'err' : ''}`}
              value={editing.current ? text : fmtVal(value, step)}
              onFocus={(e) => {
                editing.current = true;
                setText(fmtVal(value, step));
                e.target.select();
                poke();
              }}
              onChange={(e) => setText(e.target.value)}
              onBlur={(e) => commitText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
                  const nv = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value + k));
                  if (factor !== 1) store(nv);
                  else setParam(def.id, String(+nv.toFixed(6)));
                  setText(fmtVal(nv, step));
                  poke();
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
      {previews && (peek || keep) && (
        <RoundPreview
          keep={keep}
          setKeep={setKeep}
          onClose={() => {
            setKeep(false);
            setPeek(false);
          }}
        />
      )}
    </div>
  );
});

function OtherParam({ def, value }: { def: ParamDef; value: any }) {
  const setParam = useStore((s) => s.setParam);
  return (
    <div className="prow field-row" title={def.help ?? def.id} data-param={def.id}>
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
        {def.kind === 'toggle' && (
          <span className="field-row">
            <input id={`param-${def.id}`} type="checkbox" checked={!!value} onChange={(e) => setParam(def.id, e.target.checked)} />
            <label htmlFor={`param-${def.id}`}>{value ? 'On' : 'Off'}</label>
          </span>
        )}
        {def.kind === 'color' && <input type="color" value={value} onChange={(e) => setParam(def.id, e.target.value)} aria-label={def.label} />}
        {def.kind === 'text' && (
          <input
            className="inp"
            style={{ width: def.id === 'tuneNotes' || def.id === 'tuneWords' ? 170 : String(def.def).length > 12 ? 170 : 90 }}
            value={value}
            onChange={(e) => setParam(def.id, e.target.value)}
            aria-label={def.label}
          />
        )}
      </div>
    </div>
  );
}

function MasterSizePresets() {
  const setParams = useStore((s) => s.setParams);
  const params = useStore((s) => s.project.params);
  const [orientation, setOrientation] = useState<MasterOrientation>('portrait');
  const [lastPreset, setLastPreset] = useState<MasterPresetId | null>(null);
  const apply = (id: MasterPresetId) => {
    setLastPreset(id);
    setParams(masterSizePresetPatch(params, id, orientation), `Master size: ${id} ${orientation}`);
  };
  const setOri = (o: MasterOrientation) => {
    setOrientation(o);
    if (lastPreset) setParams(masterSizePresetPatch(params, lastPreset, o), `Master size: ${lastPreset} ${o}`);
  };
  return (
    <div className="prow field-row-stacked">
      <div className="field-row">
        <div className="plabel">
          <span>Outline preset</span>
        </div>
        <div className="ctrls field-row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <select
            className="sel"
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value as MasterPresetId;
              if (id) apply(id);
            }}
            aria-label="Outline size preset"
          >
            <option value="" disabled>Choose…</option>
            {MASTER_PRESET_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            className={`btn sm ${orientation === 'portrait' ? 'on' : ''}`}
            title="Portrait: longer edge along the stack length"
            onClick={() => setOri('portrait')}
          >
            Portrait
          </button>
          <button
            type="button"
            className={`btn sm ${orientation === 'landscape' ? 'on' : ''}`}
            title="Landscape: longer edge across the width"
            onClick={() => setOri('landscape')}
          >
            Landscape
          </button>
        </div>
      </div>
      <div className="perr" style={{ color: 'var(--muted)' }}>
        Fixed sizes set the base outline in real mm (A-sizes are ISO 216). Ratio presets keep the current long edge. Plate thickness and count are unchanged.
      </div>
    </div>
  );
}

function MasterButtons({ value }: { value: number }) {
  const setParam = useStore((s) => s.setParam);
  const sizes: [string, number][] = [['1:4', 0.25], ['1:3', 1 / 3], ['1:2', 0.5], ['3:4', 0.75], ['1:1', 1], ['1.5:1', 1.5], ['2:1', 2]];
  return (
    <div className="prow field-row-stacked">
      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        {sizes.map(([label, k]) => (
          <button key={label} className={`btn sm ${Math.abs(value - k) < 0.005 ? 'on' : ''}`} style={{ marginRight: -1 }} onClick={() => setParam('masterScale', String(+k.toFixed(4)))}>
            {label}
          </button>
        ))}
      </div>
      <div className="perr" style={{ color: 'var(--muted)' }}>
        Everything scales except tolerances and stock (kerf, fit clearance, min feature, sheet and ply sizes).
      </div>
    </div>
  );
}

/** The on/off switch in a group's header. */
function GroupSwitch({ id, on, group }: { id: string; on: boolean; group: string }) {
  const setParam = useStore((s) => s.setParam);
  const def = PARAM_MAP[id];
  return (
    <label className={`gswitch ${on ? 'on' : ''}`} title={def.help ?? `${on ? 'Turn off' : 'Turn on'} ${group} (settings are kept)`}>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => setParam(id, e.target.checked)} aria-label={`${group} on`} />
      <span className="track" aria-hidden />
    </label>
  );
}

export default function ParamPanel() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const v: Values = model.v;
  const filter = ui.filter.trim().toLowerCase();
  // "Changed only": just what differs from the defaults, panel by panel
  const [changedOnly, setChangedOnly] = useState(false);
  const changed = useMemo(() => changedByGroup(project.params), [project.params]);
  const totalChanged = Object.values(changed).reduce((n, ids) => n + ids.length, 0);
  const visible = (p: ParamDef) =>
    (!p.show || p.show(v)) && (!filter || p.label.toLowerCase().includes(filter) || p.id.toLowerCase().includes(filter)) && (!changedOnly || !!changed[p.group]?.includes(p.id));
  const resetGroup = (g: string) => {
    const patch = resetGroupPatch(useStore.getState().project.params, g);
    const n = Object.keys(patch).length;
    if (!n) return;
    useStore.getState().setParams(patch, `reset:${g}`);
    useStore.getState().toast(`${g}: ${n} value${n === 1 ? '' : 's'} back to default · Ctrl+Z to undo`);
  };

  const leftPane = ui.leftPane ?? 'params';
  return (
    <div>
      <div className="title-bar panel-title left-panes">
        <button type="button" className={leftPane === 'params' ? 'on' : ''} aria-pressed={leftPane === 'params'} onClick={() => setUi({ leftPane: 'params' })} data-testid="left-params-tab">
          Parameters
        </button>
        <button type="button" className={leftPane === 'saves' ? 'on' : ''} aria-pressed={leftPane === 'saves'} onClick={() => setUi({ leftPane: 'saves' })} data-testid="left-saves-tab">
          Saves
        </button>
        {leftPane === 'params' && <span className="pill" title="Every value regenerates everything downstream">live graph</span>}
      </div>
      {leftPane === 'saves' ? (
        <SavesPanel />
      ) : (
        <>
      <input className="search" type="search" placeholder="Filter parameters…" value={ui.filter} onChange={(e) => setUi({ filter: e.target.value })} aria-label="Filter parameters" />
      <label className="changed-only" data-hl="changed-only" title="Show only the parameters that differ from their defaults">
        <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
        <span>Changed only</span>
        <span className="count">{totalChanged ? `${totalChanged} changed` : 'all at defaults'}</span>
      </label>
      {changedOnly && !totalChanged && <div className="note">Every parameter is at its default.</div>}
      {GROUPS.map((g) => {
        const sw = GROUP_SWITCHES[g];
        const swShown = !!sw && (!PARAM_MAP[sw.id].show || PARAM_MAP[sw.id].show!(v));
        // a steel base turns the concrete off underneath, but the Base switch is still on
        const on = !swShown || !!v[sw!.id] || (sw!.id === 'baseOn' && !!v.steelBaseOn);
        const defs = PARAMS.filter((p) => p.group === g && !SWITCH_IDS.has(p.id) && visible(p));
        // a group that does nothing here stays listed, greyed, with the reason in place of its settings
        const idle = on ? (GROUP_IDLE[g]?.(v) ?? null) : null;
        const nChanged = changed[g]?.length ?? 0;
        if (changedOnly && !nChanged) return null;
        if (idle && filter) return null;
        if (!changedOnly && !idle && !defs.length && !(g === 'Concrete' && !filter)) return null;
        const open = filter || changedOnly ? true : !ui.collapsed[g];
        const hideBody = (!on && !sw?.keepOpen) || !!idle;
        const errs = hideBody ? 0 : defs.filter((d) => model.ev.errors[d.id]).length;
        return (
          <fieldset className={`section ${on && !idle ? '' : 'off'}`} key={g} title={idle ?? undefined} data-group={g}>
            <legend>{g}</legend>
            <div className="section-headrow field-row">
              <button className="section-head" onClick={() => setUi({ collapsed: { ...ui.collapsed, [g]: open } })} aria-expanded={open}>
                <span>{open ? 'Hide' : 'Show'}</span>
                <span className="count" style={errs ? { color: 'var(--err)' } : undefined}>
                  {nChanged > 0 && (
                    <span className="changed-badge" title={`${nChanged} changed from the default`}>
                      {nChanged}
                    </span>
                  )}
                  {errs ? `${errs} err` : idle ? 'not used' : on ? defs.length : 'off'}
                </span>
              </button>
              {nChanged > 0 && (
                <button className="group-reset" onClick={() => resetGroup(g)} title={`Put ${nChanged} changed ${g} value${nChanged === 1 ? '' : 's'} back to default (undo with Ctrl+Z)`} aria-label={`Reset ${g} to defaults`}>
                  ↺
                </button>
              )}
              {swShown && <GroupSwitch id={sw!.id} on={on} group={g} />}
            </div>
            {open && hideBody && (
              <div className="section-body">
                <div className="note section-off">{idle ?? 'Off: left out of the model and exports. Its settings are kept for when you switch it back on.'}</div>
              </div>
            )}
            {open && !hideBody && (
              <div className="section-body">
                {changedOnly && !defs.length && <div className="note section-off">Its changed values are hidden by the current setup. Reset puts them back too.</div>}
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
                      factor={scaleFactorFor(d.id, project.params)}
                      override={model.ev.overrides[d.id]}
                      overrideBy={overrideSource(d.id, project.params)}
                    />
                  ) : (
                    <OtherParam key={d.id} def={d} value={v[d.id]} />
                  ),
                )}
                {g === 'Master' && !changedOnly && (
                  <>
                    <MasterSizePresets />
                    <MasterButtons value={v.masterScale} />
                  </>
                )}
                {g === 'Concrete' && !changedOnly && <PourEditor compact />}
                {g === 'Tuning' && !changedOnly && <TuningTable />}
                {g === 'Candle master' && !changedOnly && <CandleMasterInfo />}
              </div>
            )}
          </fieldset>
        );
      })}
        </>
      )}
    </div>
  );
}
