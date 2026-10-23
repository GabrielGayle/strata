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
import { stackRodsCsv, stackRodsUnsupported } from '../core/stackRods';
import { serialize } from '../core/project';
import { zipSync } from 'fflate';
import type { Issue } from '../core/checks';
import { PriceEstimate, loadRates } from './PriceEstimate';
import { chopChopCollapsedSummary } from './chopChopSummary';
import { formatFragment } from '../core/fragments';
import { activeLibraryLinkId, grabThumb, linkActive } from './LibraryPanel';
import { recordLibrarySave } from '../state/recordLibrary';
import { PanelGrip, usePanelFrame } from './ParamPanel';
import type { Side } from '../core/panelLayout';

/** A panel's place in its column: which panel, which column, and the panel below it. */
export interface PanelPlace {
  id: string;
  side: Side;
  next: string | null;
}

/** An Inspector panel that can be dragged by the grip on its caption. */
function Framed({
  panel,
  title,
  hl,
  count,
  collapsedSummary,
  open,
  setOpen,
  children,
}: {
  panel: PanelPlace;
  title: string;
  hl?: string;
  count?: React.ReactNode;
  collapsedSummary?: string;
  open: boolean;
  setOpen: (o: boolean) => void;
  children: React.ReactNode;
}) {
  const frame = usePanelFrame(panel.id, panel.side, panel.next);
  return (
    <fieldset className={`section${frame.cls}`} data-hl={hl} {...frame.props}>
      <legend>
        <PanelGrip id={panel.id} label={title} />
        {title}
      </legend>
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

function Section({
  title,
  count,
  collapsedSummary,
  children,
  open: initial = true,
  hl,
  panel,
}: {
  /** Where the panel sits in its column, so it can be dragged. */
  panel?: PanelPlace;
  title: string;
  /** `data-hl` name for the changelog's "show me". */
  hl?: string;
  count?: React.ReactNode;
  collapsedSummary?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return panel ? (
    <Framed panel={panel} title={title} hl={hl} count={count} collapsedSummary={collapsedSummary} open={open} setOpen={setOpen}>
      {children}
    </Framed>
  ) : (
    <fieldset className="section" data-hl={hl}>
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
        <button key={k} className="issue" data-issue-type={i.type} data-issue-severity={i.severity} onClick={() => i.partId && setUi({ selected: i.partId, tab: 'plates' })}>
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

/** The top of the Inspector column. */
export function InspectorHead() {
  const stale = useModel().stale;
  return (
    <div className="title-bar panel-title">
      <span>Inspector</span>
      {stale && <span className="pill stale">updating</span>}
    </div>
  );
}

function SummaryPanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const b = model.bom;
  return (
    <>
      <Section panel={panel} title="Summary">
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

      {model.issues.some((i) => i.type === 'hidden' && i.severity === 'warn') && (
        <div className="note warn hidden-card-notice" data-testid="hidden-card-notice">
          {model.issues
            .filter((i) => i.type === 'hidden' && i.severity === 'warn')
            .map((i) => i.message)
            .join(' ')}
        </div>
      )}

      </Section>
    </>
  );
}

function FitPanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const v = model.v;
  const errors = model.issues.filter((i) => i.severity === 'error');
  const warns = model.issues.filter((i) => i.severity === 'warn');
  const infos = model.issues.filter((i) => i.severity === 'info');
  const bevelMax = Math.max(0, ...model.sliced.plates.map((p) => p.bevel));
  return (
    <>
      <Section panel={panel} title="Fit checks" count={<span style={{ color: errors.length ? 'var(--err)' : 'var(--ok)' }}>{errors.length} err · {warns.length} warn</span>}>
        <div data-testid="fit-checks">
          <IssueList issues={[...errors, ...warns, ...infos.filter((i) => i.type === 'fragment' || i.type === 'hidden')]} />
        </div>
        <div className="note">
          Edges: 0 non-90° — every part is a 2D outline extruded straight.
          {bevelMax > 0.01 && ` Largest bevel avoided: ${fmt(bevelMax, 2)} mm (cavities use the ${v.cavityMode} section + ${fmt(v.clearance, 1)} mm clearance).`}
          {infos.length > 0 && ` ${infos.length} info notes.`}
        </div>
      </Section>

    </>
  );
}

function PolesPanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const fullModel = useFullModel();
  const project = useStore((s) => s.project);
  const base = (project.name || 'strata').replace(/[^\w-]+/g, '_');
  const stackUnsupported = stackRodsUnsupported(model.sliced.stackRods);
  return (
    <>
      {model.sliced.stackRods && (
        <div data-testid="inspector-support-poles">
          <Section panel={panel} title="Support poles" count={`${model.sliced.stackRods.rods.length} rod${model.sliced.stackRods.rods.length === 1 ? '' : 's'}`}>
            {model.sliced.stackRods.rods.length > 0 && (
              <dl className="kv">
                {model.sliced.stackRods.rods.map((r) => (
                  <Fragment key={r.id}>
                    <dt>{r.id}</dt>
                    <dd>
                      Ø{fmt(r.diameter, 1)} × {fmt(r.length, 1)} mm
                      <small style={{ display: 'block', color: 'var(--muted)' }}>hole Ø{fmt(r.hole, 1)} mm</small>
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {stackUnsupported.length > 0 && (
              <ul className="note" data-testid="inspector-support-poles-unsupported" style={{ margin: '8px 0', paddingLeft: 18 }}>
                {stackUnsupported.map((i, k) => (
                  <li key={`${i.plateKey ?? ''}:${i.partId ?? k}`}>
                    {i.plateKey ?? 'Layer'} {i.partId ?? ''} — {i.held ? 'too small for a pole (already held)' : 'unsupported'}
                  </li>
                ))}
              </ul>
            )}
            {model.sliced.stackRods.alignmentOnly && model.sliced.stackRods.rods.length > 0 && (
              <div className="note" data-testid="inspector-support-poles-alignment">
                {model.sliced.stackRods.rods.length} alignment rod{model.sliced.stackRods.rods.length === 1 ? '' : 's'}; no island needs support
              </div>
            )}
            {model.sliced.stackRods.rods.length === 0 && stackUnsupported.length === 0 && (
              <div className="note">No extra poles: every island is already held (registration pins count).</div>
            )}
            <div className="note">
              Vertical steel through islands that would otherwise float, down to the base. Islands on the first layer and islands resting on a held island below do not need their own rod.
              Hole Ø is pole + weld clearance.
            </div>
            {model.sliced.stackRods.rods.length > 0 && (
              <div className="btnrow">
                <button
                  className="btn sm"
                  onClick={() => {
                    const plan = fullModel().sliced.stackRods;
                    if (plan) download(`${base}-rods.csv`, stackRodsCsv(plan), 'text/csv');
                  }}
                >
                  Rods CSV
                </button>
              </div>
            )}
          </Section>
        </div>
      )}

    </>
  );
}

function BracingPanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const fullModel = useFullModel();
  const project = useStore((s) => s.project);
  const b = model.bom;
  const base = (project.name || 'strata').replace(/[^\w-]+/g, '_');
  return (
    <>
      {model.sliced.brace && (b.hardware.length > 0 || (model.sliced.brace.spacers?.parts.length ?? 0) > 0) && (
        <Section panel={panel} title="Bracing" hl="inspector-bracing" count={b.hardware.length ? `${b.hardware.reduce((a, r) => a + r.qty, 0)} hardware` : 'spacers'}>
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

    </>
  );
}

function PricePanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const b = model.bom;
  const v = model.v;
  const chopSummary = useMemo(
    () => chopChopCollapsedSummary(b, v.thickness, loadRates()),
    [b, v.thickness],
  );
  return (
    <>
      <Section panel={panel} title="Price estimate" hl="chop-chop-price" count="estimate" collapsedSummary={chopSummary}>
        <PriceEstimate bom={b} material={v.plateMaterial} thickness={v.thickness} />
      </Section>

    </>
  );
}

function SelectedPanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const b = model.bom;
  const v = model.v;
  const selected = useStore((s) => s.ui.selected);
  const sel = model.sliced.parts.find((p) => p.id === selected);
  return (
    <>
      {sel && (
        <Section panel={panel} title={`Selected ${sel.id}`}>
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

    </>
  );
}

function ExportPanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  const fullModel = useFullModel();
  const project = useStore((s) => s.project);
  const b = model.bom;
  const v = model.v;
  const base = (project.name || 'strata').replace(/[^\w-]+/g, '_');
  const toast = useStore((s) => s.toast);
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
    <>
      <Section panel={panel} title="Export" hl="inspector-export">
        <div className="btnrow">
          <button
            className="btn default"
            onClick={() => {
              try {
                const ran = withExportLock(() => {
                  const m = fullModel();
                  download(`${base}-fabrication.zip`, buildZip(m, project), 'application/zip');
                  void recordLibrarySave(project, { source: 'export', plates: m.sliced.plates.length, thumb: grabThumb(), linkId: activeLibraryLinkId() })
                    .then((meta) => linkActive(meta.id, project))
                    .catch((err) => toast(`Exported, but Projects failed: ${(err as Error).message}`));
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

    </>
  );
}

function PipelinePanel({ panel }: { panel: PanelPlace }) {
  const model = useModel();
  return (
    <>
      <Section panel={panel} title="Pipeline" count={`${model.stages.filter((s) => !s.cached).length} rebuilt`} open={false}>
        {model.stages.map((s) => (
          <div key={s.name} className={`stage ${!s.cached ? 'fresh' : ''}`}>
            <span>{s.name}</span>
            <span className="ms">{s.stale ? 'pending' : s.cached ? 'cached' : 'rebuilt'}</span>
            <span className="ms">{fmt(s.ms, 0)} ms</span>
          </div>
        ))}
        <div className="note">Each stage re-runs only when one of its inputs changes. Exports are always regenerated from parameters.</div>
      </Section>
    </>
  );
}

const PANELS: Record<string, (p: { panel: PanelPlace }) => React.ReactNode> = {
  'insp:summary': SummaryPanel,
  'insp:fit': FitPanel,
  'insp:poles': PolesPanel,
  'insp:bracing': BracingPanel,
  'insp:price': PricePanel,
  'insp:selected': SelectedPanel,
  'insp:export': ExportPanel,
  'insp:pipeline': PipelinePanel,
};

/** One Inspector panel by id, in whichever column it sits. */
export function InspectorPanel({ panel }: { panel: PanelPlace }) {
  const P = PANELS[panel.id];
  return P ? <P panel={panel} /> : null;
}
