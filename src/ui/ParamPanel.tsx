import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { GROUPS, GROUP_IDLE, GROUP_SWITCHES, PARAM_MAP, overrideSource, scaleFactorFor, type ParamDef, type Values } from '../core/params';
import TuningTable from './TuningTable';
import FormulaBox from './FormulaBox';
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
import { create } from 'zustand';
import { controlsIn, type PanelLayout, type Side } from '../core/panelLayout';
import { KNOWN, groupPanel, panelGroup, usePanels } from '../state/panelLayout';
import { controlDropProps, gripKeys, gripProps, panelDropProps, useDrag } from './panelDrag';

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
  const [fxOpen, setFxOpen] = useState(0);
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
        <button className={`ibtn ${exprMode ? 'on' : ''}`} title="Edit as expression (link to other parameters)" onClick={() => {
            // into formula mode: focus the box and list what it can use
            if (!exprMode) setFxOpen((n) => n + 1);
            setExprMode(!exprMode);
          }} aria-pressed={exprMode}>
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
            <FormulaBox
              def={def}
              text={text}
              error={error}
              openSignal={fxOpen}
              onFocus={() => (editing.current = true)}
              onEdit={(t) => {
                editing.current = true;
                setText(t);
              }}
              onCommit={commitText}
              onRevert={() => {
                editing.current = false;
                setText(raw);
              }}
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

type GroupName = (typeof GROUPS)[number];

/** "Changed only": just what differs from the defaults, panel by panel (shared by every parameter panel, wherever it sits). */
const useChangedOnly = create<{ on: boolean }>(() => ({ on: false }));

/** What every parameter panel needs to decide which rows to show. */
function useParamView() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const rawFilter = useStore((s) => s.ui.filter);
  const changedOnly = useChangedOnly((s) => s.on);
  const changed = useMemo(() => changedByGroup(project.params), [project.params]);
  const v: Values = model.v;
  const filter = rawFilter.trim().toLowerCase();
  const visible = (p: ParamDef) =>
    (!p.show || p.show(v)) && (!filter || p.label.toLowerCase().includes(filter) || p.id.toLowerCase().includes(filter)) && (!changedOnly || !!changed[p.group]?.includes(p.id));
  return { model, project, v, filter, changedOnly, changed, visible };
}
type ParamView = ReturnType<typeof useParamView>;

/** A group's switch (when it has one showing), whether it is on, and why it does nothing when it is on but idle. */
function groupState(g: string, v: Values) {
  const sw = GROUP_SWITCHES[g as GroupName];
  const swShown = !!sw && (!PARAM_MAP[sw.id].show || PARAM_MAP[sw.id].show!(v));
  // a steel base turns the concrete off underneath, but the Base switch is still on
  const on = !swShown || !!v[sw!.id] || (sw!.id === 'baseOn' && !!v.steelBaseOn);
  const idle = on ? (GROUP_IDLE[g as GroupName]?.(v) ?? null) : null;
  return { sw, swShown, on, idle };
}

/** The controls showing in a panel now, in order. */
function shownIn(layout: PanelLayout, panel: string, view: ParamView) {
  return controlsIn(layout, panel, KNOWN).filter((id) => view.visible(PARAM_MAP[id]));
}

/** One control: its row, plus (in Edit layout) a grip to drag it and, away from home, where it came from. */
function ParamRow({ def, panel, next, view }: { def: ParamDef; panel: string; next: string | null; view: ParamView }) {
  const { model, project, v } = view;
  const ui = useStore((s) => s.ui);
  const editing = usePanels((s) => s.editing);
  const dropHere = useDrag((s) => s.spot?.in === panel && s.spot.before === def.id);
  const dragged = useDrag((s) => s.drag?.kind === 'control' && s.drag.id === def.id);
  const visiting = panelGroup(panel) !== def.group;
  const home = visiting ? groupState(def.group, v) : null;
  const homeOff = !!home && (!home.on || !!home.idle);
  const row =
    def.kind === 'number' ? (
      <NumberParam
        def={def}
        raw={String(project.params[def.id] ?? def.def)}
        value={v[def.id]}
        error={model.ev.errors[def.id]}
        clamped={model.ev.clamped[def.id]}
        locked={!!project.locks[def.id]}
        focus={ui.focusParam === def.id}
        factor={scaleFactorFor(def.id, project.params)}
        override={model.ev.overrides[def.id]}
        overrideBy={overrideSource(def.id, project.params)}
      />
    ) : (
      <OtherParam def={def} value={v[def.id]} />
    );
  const shown = (p: string) => shownIn(usePanels.getState().layout, p, view);
  return (
    <div className={`ctl${editing ? ' editing' : ''}${dropHere ? ' drop-before' : ''}${dragged ? ' dragging' : ''}${homeOff ? ' home-off' : ''}`} data-ctl={def.id} {...controlDropProps(def.id, panel, next)}>
      {editing && (
        <button type="button" className="grip ctl-grip" data-grip-control={def.id} {...gripProps('control', def.id, def.label)} onKeyDown={gripKeys('control', def.id, shown)} title="Drag to move this control to another place or panel. Arrow keys move it a step.">
          ⠿
        </button>
      )}
      <div className="ctl-body">
        {visiting && (
          <div className="ctl-from" title={homeOff ? `${def.group} is ${home!.idle ? 'not used here' : 'switched off'}, so this does nothing until it is on again` : `Lives in ${def.group}; moved here`}>
            from {def.group}
            {homeOff ? (home!.idle ? ' · not used' : ' · off') : ''}
            {editing && (
              <button type="button" className="ctl-home" onClick={() => usePanels.getState().sendHome(def.id)} title={`Put it back in ${def.group}`}>
                back
              </button>
            )}
          </div>
        )}
        {row}
      </div>
    </div>
  );
}

/** The grip on a panel's caption: drag it up, down or to the other column (arrow keys too). */
export function PanelGrip({ id, label }: { id: string; label: string }) {
  return (
    <span className="grip panel-grip" role="button" tabIndex={0} data-grip-panel={id} {...gripProps('panel', id, `the ${label} panel`)} onKeyDown={gripKeys('panel', id)} title={`Drag to move the ${label} panel up, down or to the other side. Arrow keys move it a step; Left and Right swap sides.`}>
      ⠿
    </span>
  );
}

/** A panel's frame: drop marks, and where a dragged panel or control lands. */
export function usePanelFrame(id: string, side: Side, next: string | null) {
  const dropBefore = useDrag((s) => s.drag?.kind === 'panel' && s.spot?.in === side && s.spot.before === id);
  const dropInto = useDrag((s) => s.drag?.kind === 'control' && s.spot?.in === id && s.spot.before === null);
  const dragged = useDrag((s) => s.drag?.kind === 'panel' && s.drag.id === id);
  return {
    cls: `${dropBefore ? ' drop-before' : ''}${dropInto ? ' drop-into' : ''}${dragged ? ' dragging' : ''}`,
    props: { ...panelDropProps(id, side, next), 'data-panel': id },
  };
}

/** Edit layout's "put this panel back how it was" button, when something in it moved. */
function PanelLayoutReset({ id, name }: { id: string; name: string }) {
  const editing = usePanels((s) => s.editing);
  const touched = usePanels((s) => !!s.layout.order[id] || Object.values(s.layout.moved).includes(id) || KNOWN.controls.some((c) => c.home === id && c.id in s.layout.moved));
  if (!editing || !touched) return null;
  return (
    <button className="group-reset" onClick={() => usePanels.getState().resetPanel(id)} title={`Put the controls in ${name} back where they started (moved-in ones go home, moved-out ones come back)`} aria-label={`Reset the layout of ${name}`}>
      ⟲
    </button>
  );
}

/** One parameter group's panel, wherever it sits. Moved-in controls show here too; moved-out ones don't. */
export function ParamGroupPanel({ group: g, side, next }: { group: string; side: Side; next: string | null }) {
  const view = useParamView();
  const { model, v, filter, changedOnly, changed, visible } = view;
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const layout = usePanels((s) => s.layout);
  const editing = usePanels((s) => s.editing);
  const id = groupPanel(g);
  const frame = usePanelFrame(id, side, next);
  const resetGroup = () => {
    const patch = resetGroupPatch(useStore.getState().project.params, g);
    const n = Object.keys(patch).length;
    if (!n) return;
    useStore.getState().setParams(patch, `reset:${g}`);
    useStore.getState().toast(`${g}: ${n} value${n === 1 ? '' : 's'} back to default · Ctrl+Z to undo`);
  };
  const { sw, swShown, on, idle } = groupState(g, v);
  const ids = controlsIn(layout, id, KNOWN);
  const defs = ids.map((x) => PARAM_MAP[x]).filter(visible);
  // a group that does nothing here stays listed, greyed, with the reason in place of its settings
  const nChanged = changed[g]?.length ?? 0;
  if (changedOnly && !nChanged && !defs.length) return null;
  if (idle && filter) return null;
  if (!changedOnly && !idle && !defs.length && !(g === 'Concrete' && !filter) && !editing) return null;
  const open = filter || changedOnly ? true : !ui.collapsed[g];
  const hideBody = (!on && !sw?.keepOpen) || !!idle;
  const errs = hideBody ? 0 : defs.filter((d) => model.ev.errors[d.id]).length;
  return (
    <fieldset className={`section ${on && !idle ? '' : 'off'}${frame.cls}`} key={g} title={idle ?? undefined} data-group={g} {...frame.props}>
      <legend>
        <PanelGrip id={id} label={g} />
        {g}
      </legend>
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
        <PanelLayoutReset id={id} name={g} />
        {nChanged > 0 && (
          <button className="group-reset" onClick={resetGroup} title={`Put ${nChanged} changed ${g} value${nChanged === 1 ? '' : 's'} back to default (undo with Ctrl+Z)`} aria-label={`Reset ${g} to defaults`}>
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
          {editing && !defs.length && <div className="note section-off">Empty: drag controls here, or Reset to bring its own back.</div>}
          {defs.map((d, i) => (
            <ParamRow key={d.id} def={d} panel={id} next={defs[i + 1]?.id ?? null} view={view} />
          ))}
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
}

/** A panel the person made (Layout › New panel): whichever controls they drop in. */
export function CustomParamPanel({ id, side, next }: { id: string; side: Side; next: string | null }) {
  const view = useParamView();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const layout = usePanels((s) => s.layout);
  const editing = usePanels((s) => s.editing);
  const frame = usePanelFrame(id, side, next);
  const name = layout.custom.find((c) => c.id === id)?.name ?? 'My panel';
  const ids = controlsIn(layout, id, KNOWN);
  const defs = ids.map((x) => PARAM_MAP[x]).filter(view.visible);
  if ((view.filter || view.changedOnly) && !defs.length) return null;
  const open = view.filter || view.changedOnly ? true : !ui.collapsed[id];
  return (
    <fieldset className={`section custom-panel${frame.cls}`} data-hl="custom-panel" {...frame.props}>
      <legend>
        <PanelGrip id={id} label={name} />
        {name}
      </legend>
      <div className="section-headrow field-row">
        <button className="section-head" onClick={() => setUi({ collapsed: { ...ui.collapsed, [id]: open } })} aria-expanded={open}>
          <span>{open ? 'Hide' : 'Show'}</span>
          <span className="count">{defs.length}</span>
        </button>
        {editing && (
          <>
            <button
              className="group-reset"
              title="Rename this panel"
              aria-label={`Rename ${name}`}
              onClick={() => {
                const n = window.prompt('Name for this panel', name);
                if (n) usePanels.getState().renamePanel(id, n);
              }}
            >
              ✎
            </button>
            <button
              className="group-reset"
              title="Remove this panel. Its controls go back to their own panels."
              aria-label={`Remove ${name}`}
              onClick={() => {
                if (!ids.length || window.confirm(`Remove the panel "${name}"? Its ${ids.length} control${ids.length === 1 ? '' : 's'} go back to their own panels.`)) usePanels.getState().removePanel(id);
              }}
            >
              ✕
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="section-body">
          {!ids.length && <div className="note section-off">{editing ? 'Drag controls here by their ⠿ grip.' : 'Empty. Layout › Edit layout, then drag controls here by their grip.'}</div>}
          {defs.map((d, i) => (
            <ParamRow key={d.id} def={d} panel={id} next={defs[i + 1]?.id ?? null} view={view} />
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** The bar that shows while Edit layout is on. */
export function EditLayoutBar() {
  const editing = usePanels((s) => s.editing);
  if (!editing) return null;
  return (
    <div className="edit-layout-bar" data-hl="edit-layout-bar" role="region" aria-label="Edit layout">
      <span>Drag ⠿ to move controls and panels. Layout › Reset puts everything back.</span>
      <span className="btnrow">
        <button
          className="btn sm"
          data-hl="new-panel"
          onClick={() => {
            const n = window.prompt('Name for the new panel', 'My favourites');
            if (n) usePanels.getState().addPanel(n);
          }}
        >
          + New panel
        </button>
        <button className="btn sm default" onClick={() => usePanels.getState().setEditing(false)}>
          Done
        </button>
      </span>
    </div>
  );
}

/** The top of the Parameters column: Parameters | Saves, the filter and Changed only. */
export default function ParamHead({ children }: { children?: React.ReactNode }) {
  const project = useStore((s) => s.project);
  const leftPane = useStore((s) => s.ui.leftPane ?? 'params');
  const filter = useStore((s) => s.ui.filter);
  const setUi = useStore((s) => s.setUi);
  const changedOnly = useChangedOnly((s) => s.on);
  const editing = usePanels((s) => s.editing);
  const changed = useMemo(() => changedByGroup(project.params), [project.params]);
  const totalChanged = Object.values(changed).reduce((n, ids) => n + ids.length, 0);
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
        {leftPane === 'params' && (
          <button
            type="button"
            className={`edit-layout-btn ${editing ? 'on' : ''}`}
            aria-pressed={editing}
            data-hl="edit-layout-toggle"
            onClick={() => usePanels.getState().setEditing(!editing)}
            title="Edit layout: drag controls to reorder them or move them into other panels (Layout menu has more)"
          >
            ✥
          </button>
        )}
      </div>
      {leftPane === 'saves' ? (
        <SavesPanel />
      ) : (
        <>
          <EditLayoutBar />
          <input className="search" type="search" placeholder="Filter parameters…" value={filter} onChange={(e) => setUi({ filter: e.target.value })} aria-label="Filter parameters" />
          <label className="changed-only" data-hl="changed-only" title="Show only the parameters that differ from their defaults">
            <input type="checkbox" checked={changedOnly} onChange={(e) => useChangedOnly.setState({ on: e.target.checked })} />
            <span>Changed only</span>
            <span className="count">{totalChanged ? `${totalChanged} changed` : 'all at defaults'}</span>
          </label>
          {changedOnly && !totalChanged && <div className="note">Every parameter is at its default.</div>}
          {children}
        </>
      )}
    </div>
  );
}
