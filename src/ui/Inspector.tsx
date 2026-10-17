import { Fragment, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { useFullModel, useModel, fmt, fmtInt } from './model';
import {
  assertExportable,
  buildPackHtmlChecked,
  buildZip,
  download,
  exportFailureMessage,
  modelStl,
  openHtml,
  partDxf,
  partFiles,
  pourPlanText,
  sheetFiles,
  withExportLock,
} from '../core/exporters';
import { cutListCsv, hardwareCsv, MATERIAL_NAME } from '../core/bom';
import { serialize } from '../core/project';
import { zipSync } from 'fflate';
import type { Issue } from '../core/checks';
import { PriceEstimate, loadRates } from './PriceEstimate';
import { chopChopCollapsedSummary } from './chopChopSummary';
import { formatFragment } from '../core/fragments';
import { grabThumb } from './LibraryPanel';
import { recordLibrarySave } from '../state/recordLibrary';

function Section({
  title,
  count,
  collapsedSummary,
  children,
  open: initial = true,
}: {
  title: string;
  count?: React.ReactNode;
  collapsedSummary?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <fieldset className="section">
      <legend>{title}</legend>
      <div className="field-row">
        <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="section-head-main">
            {open ? 'Hide' : 'Show'}
            {open && count !== undefined && <span className="count"> {count}</span>}
          </span>
          {!open && collapsedSummary && (
            <span className="section-collapsed-summary" title={collapsedSummary}>{collapsedSummary}</span>
          )}
        </button>
      </div>
      {open && children}
    </fieldset>
  );
}

export function IssueList({ issues, limit = 60 }: { issues: Issue[]; limit?: number }) {
  const setUi = useStore((s) => s.setUi);
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  if (!issues.length)
    return (
      <div className="issue" style={{ cursor: 'default' }}>
        <span className="dot ok" />
        <span>All parts pass: 90° edges, min feature, kerf gaps, insert fit.</span>
      </div>
    );
  return (
    <>
      {sorted.slice(0, limit).map((i, k) => (
        <button key={k} className="issue" onClick={() => i.partId && setUi({ selected: i.partId, tab: 'plates' })}>
          <span className={`dot ${i.severity}`} />
          <span>
            {i.partId && <span className="pid">{i.partId}</span>}
            {i.message}
          </span>
        </button>
      ))}
      {sorted.length > limit && <div className="note">+ {sorted.length - limit} more</div>}
    </>
  );
}

export default function Inspector() {
  const model = useModel();
  const fullModel = useFullModel();
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const toast = useStore((s) => s.toast);
  const b = model.bom;
  const v = model.v;
  const errors = model.issues.filter((i) => i.severity === 'error');
  const warns = model.issues.filter((i) => i.severity === 'warn');
  const infos = model.issues.filter((i) => i.severity === 'info');
  const base = (project.name || 'strata').replace(/[^\w-]+/g, '_');
  const sel = model.sliced.parts.find((p) => p.id === ui.selected);
  const bevelMax = Math.max(0, ...model.sliced.plates.map((p) => p.bevel));
  const chopSummary = useMemo(
    () => chopChopCollapsedSummary(b, v.thickness, loadRates()),
    [b, v.thickness],
  );

  const plateZip = () => {
    try {
      const m = fullModel();
      assertExportable(m);
      download(`${base}-plates.zip`, zipSync(partFiles(m, useStore.getState().project)), 'application/zip');
    } catch (e) {
      toast(exportFailureMessage(e));
    }
  };
  const sheetZip = () => {
    try {
      const m = fullModel();
      assertExportable(m);
      download(`${base}-sheets.zip`, zipSync(sheetFiles(m)), 'application/zip');
    } catch (e) {
      toast(exportFailureMessage(e));
    }
  };

  return (
    <div>
      <div className="title-bar panel-title">
        <span>Inspector</span>
        {model.stale && <span className="pill stale">updating</span>}
      </div>
      <div className="stats">
        <div className="stat" data-testid="inspector-plates">
          <div className="k">Plates</div>
          <div className="v" data-in-app-plates={model.sliced.plates.length}>
            {model.sliced.plates.length}{' '}
            <small>
              {b.partCount} parts
              {b.plateCount !== model.sliced.plates.length ? ` · ${b.plateCount} cut` : ''}
            </small>
          </div>
        </div>
        <div className="stat">
          <div className="k">Sheets</div>
          <div className="v">
            {b.sheets} <small>{fmt(b.utilisation * 100, 0)}% used</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">Metal</div>
          <div className="v">
            {fmt(b.plateMass, 1)} <small>kg</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">Cut length</div>
          <div className="v">
            {fmt(b.cutLength, 1)} <small>m · {b.pierces} pierces</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">Concrete</div>
          <div className="v">
            {fmt(b.concreteBase + b.concreteInsert, 1)} <small>L · {fmt(b.concreteMass, 0)} kg</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">Plywood</div>
          <div className="v">
            {b.plyParts} <small>parts · {b.plySheets} sheets</small>
          </div>
        </div>
      </div>

      {(model.sliced.fragments ?? []).length > 0 && (
        <div className="note" data-testid="fragment-notice" style={{ margin: '8px 10px 0' }}>
          {(model.sliced.fragments ?? []).map((e) => formatFragment(e)).join(' ')}
        </div>
      )}

      <Section title="Fit checks" count={<span style={{ color: errors.length ? 'var(--err)' : 'var(--ok)' }}>{errors.length} err · {warns.length} warn</span>}>
        <IssueList issues={[...errors, ...warns, ...infos.filter((i) => i.type === 'fragment')]} />
        <div className="note">
          Edges: 0 non-90° — every part is a 2D outline extruded straight.
          {bevelMax > 0.01 && ` Largest bevel avoided: ${fmt(bevelMax, 2)} mm (cavities use the ${v.cavityMode} section + ${fmt(v.clearance, 1)} mm clearance).`}
          {infos.length > 0 && ` ${infos.length} info notes.`}
        </div>
      </Section>

      {model.sliced.brace && (b.hardware.length > 0 || (model.sliced.brace.spacers?.parts.length ?? 0) > 0) && (
        <Section title="Bracing" count={b.hardware.length ? `${b.hardware.reduce((a, r) => a + r.qty, 0)} hardware` : 'spacers'}>
          {b.hardware.length > 0 && (
            <dl className="kv">
              {b.hardware.map((r) => (
                <Fragment key={r.item + r.spec}>
                  <dt>{r.item}</dt>
                  <dd>
                    {r.qty} × {r.spec}
                    {r.note && <small style={{ display: 'block', color: 'var(--muted)' }}>{r.note}</small>}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          <div className="note">
            {model.sliced.brace.rods && model.sliced.brace.rods.rods.length > 0 && (() => {
              const rods = model.sliced.brace.rods.rods;
              const steel = rods.filter((r) => !r.embedded).length;
              return `Rods snap to the shortest stock length that spans the stack and its nuts and stays inside the base, or get cut down. ${steel ? `${steel} of ${rods.length} run through the exposed steel. ` : ''}`;
            })()}
            {(() => {
              const sp = model.sliced.brace.spacers?.parts ?? [];
              const c = sp.filter((p) => p.family === 'C').length;
              const t = sp.filter((p) => p.family === 'T').length;
              return [c && `${c} cross piece${c > 1 ? 's' : ''} (cast in)`, t && `${t} spacing template${t > 1 ? 's' : ''} (lift off)`].filter(Boolean).join(' and ') + (c || t ? ' cut with the plates.' : '');
            })()}
          </div>
          {b.hardware.length > 0 && (
            <div className="btnrow">
              <button className="btn sm" onClick={() => download(`${base}-hardware.csv`, hardwareCsv(fullModel().bom), 'text/csv')}>
                Hardware CSV
              </button>
            </div>
          )}
        </Section>
      )}

      <Section title="Chop Chop price" count="estimate" collapsedSummary={chopSummary}>
        <PriceEstimate bom={b} material={v.plateMaterial} thickness={v.thickness} />
      </Section>

      {sel && (
        <Section title={`Selected ${sel.id}`}>
          <dl className="kv">
            <dt>Size</dt>
            <dd>
              {fmt(sel.bbox.maxX - sel.bbox.minX, 1)} × {fmt(sel.bbox.maxY - sel.bbox.minY, 1)} mm
            </dd>
            <dt>Area</dt>
            <dd>{fmtInt(sel.area)} mm²</dd>
            <dt>Mass</dt>
            <dd>{fmt(b.rows.find((r) => r.id === sel.id)?.mass ?? 0, 2)} kg</dd>
            <dt>Holes / cut-outs</dt>
            <dd>{sel.shape[0].holes.length}</dd>
            <dt>Anchored</dt>
            <dd>{sel.anchored ? 'yes' : 'NO'}</dd>
            {sel.plateId && sel.plateId !== sel.id && (
              <>
                <dt>Plate</dt>
                <dd>part of {sel.plateId}</dd>
              </>
            )}
          </dl>
          <div className="btnrow">
            <button className="btn sm" onClick={() => download(`${sel.id}.dxf`, partDxf(sel, v), 'application/dxf')}>
              DXF
            </button>
            <button className="btn sm" onClick={() => useStore.getState().setUi({ tab: 'plates' })}>
              Open in Plates
            </button>
          </div>
        </Section>
      )}

      <Section title="Export">
        <div className="btnrow">
          <button
            className="btn default"
            onClick={() => {
              try {
                const ran = withExportLock(() => {
                  const m = fullModel();
                  download(`${base}-fabrication.zip`, buildZip(m, project), 'application/zip');
                  void recordLibrarySave(project, { source: 'export', plates: m.sliced.plates.length, thumb: grabThumb() }).catch((err) =>
                    toast(`Exported, but Projects failed: ${(err as Error).message}`),
                  );
                });
                if (!ran.ok) toast('Export already running');
                else toast('Fabrication ZIP exported');
              } catch (e) {
                toast(exportFailureMessage(e));
              }
            }}
          >
            Everything (ZIP)
          </button>
          <button
            className="btn"
            onClick={() => {
              try {
                const ran = withExportLock(() => {
                  openHtml(buildPackHtmlChecked(project, fullModel(), { rates: loadRates() }));
                });
                if (!ran.ok) toast('Build pack already opening');
              } catch (e) {
                toast(exportFailureMessage(e));
              }
            }}
            title="Printable plate layout, assembly order, rods and spacers, glue-up and pour plan"
          >
            Build pack
          </button>
          <button className="btn" onClick={plateZip}>
            Plate DXFs ({b.plateCount} plates · {model.sliced.parts.length} parts)
          </button>
          <button className="btn" onClick={sheetZip}>
            Nested sheets ({b.sheets})
          </button>
          <button className="btn" onClick={() => download(`${base}-cutlist.csv`, cutListCsv(v, fullModel().bom), 'text/csv')}>
            Cut list CSV
          </button>
          <button className="btn" onClick={() => download(`${base}.stl`, modelStl(model), 'model/stl')}>
            Model STL
          </button>
          <button className="btn" onClick={() => download(`${base}-pour-plan.txt`, pourPlanText(fullModel()), 'text/plain')}>
            Pour plan
          </button>
          <button className="btn" onClick={() => download(`${base}.strata.json`, serialize(project), 'application/json')}>
            Project JSON
          </button>
        </div>
        <div className="note">
          DXF 2000, mm. Outlines are LWPOLYLINE; round holes are CIRCLE. Nested sheets are cut-only (sheet-NN-cut.dxf: CUT layer, no sheet border). Etch/engrave is a sidecar (sheet-NN-etch.dxf). Kerf {fmt(v.kerf, 2)} mm
          compensated, arcs within {fmt(v.arcTolerance, 3)} mm. {b.byMaterial.filter((g) => g.partCount).map((g) => `${MATERIAL_NAME[g.material] ?? g.material} (${g.partCount})`).join(' + ') || MATERIAL_NAME[v.plateMaterial]} {fmt(v.thickness, 1)} mm.
          {b.byMaterial.filter((g) => g.partCount).length > 1 && ' Mixed metals: the ZIP puts each metal’s parts and sheets in its own folder, and every sheet carries one metal.'}
        </div>
      </Section>

      <Section title="Pipeline" count={`${model.stages.filter((s) => !s.cached).length} rebuilt`} open={false}>
        {model.stages.map((s) => (
          <div key={s.name} className={`stage ${!s.cached ? 'fresh' : ''}`}>
            <span>{s.name}</span>
            <span className="ms">{s.stale ? 'pending' : s.cached ? 'cached' : 'rebuilt'}</span>
            <span className="ms">{fmt(s.ms, 0)} ms</span>
          </div>
        ))}
        <div className="note">Each stage re-runs only when one of its inputs changes. Exports are always regenerated from parameters.</div>
      </Section>
    </div>
  );
}
