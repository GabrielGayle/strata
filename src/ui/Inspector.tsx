import { Fragment, useState } from 'react';
import { useStore } from '../state/store';
import { useFullModel, useModel, fmt, fmtInt } from './model';
import { buildZip, download, modelStl, partDxf, pourPlanText, sheetDxf } from '../core/exporters';
import { cutListCsv, hardwareCsv, MATERIAL_NAME } from '../core/bom';
import { serialize } from '../core/project';
import { zipSync, strToU8 } from 'fflate';
import type { Issue } from '../core/checks';
import { PriceEstimate } from './PriceEstimate';

function Section({ title, count, children, open: initial = true }: { title: string; count?: React.ReactNode; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="section">
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          {open ? '−' : '+'} {title}
        </span>
        {count !== undefined && <span className="count">{count}</span>}
      </button>
      {open && children}
    </section>
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

  const plateZip = () => {
    const m = fullModel();
    const files: Record<string, Uint8Array> = {};
    for (const p of m.sliced.parts) files[`${p.id}.dxf`] = strToU8(partDxf(p, m.v));
    download(`${base}-plates.zip`, zipSync(files), 'application/zip');
  };
  const sheetZip = () => {
    const m = fullModel();
    const files: Record<string, Uint8Array> = {};
    m.nested.sheets.forEach((s, i) => (files[`sheet-${String(i + 1).padStart(2, '0')}.dxf`] = strToU8(sheetDxf(m, s.index))));
    download(`${base}-sheets.zip`, zipSync(files), 'application/zip');
  };

  return (
    <div>
      <div className="panel-title">
        <span>Inspector</span>
        {model.stale && <span className="pill stale">updating</span>}
      </div>
      <div className="stats">
        <div className="stat">
          <div className="k">Plates</div>
          <div className="v">
            {b.plateCount} <small>{b.partCount !== b.plateCount ? `${b.partCount} parts` : ''}</small>
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

      <Section title="Fit checks" count={<span style={{ color: errors.length ? 'var(--err)' : 'var(--ok)' }}>{errors.length} err · {warns.length} warn</span>}>
        <IssueList issues={[...errors, ...warns]} />
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
            {model.sliced.brace.rods && `Rods snap to ${model.sliced.brace.rods.length.cut ? 'a cut length' : 'stock'}: the stack and nuts need ${fmt(model.sliced.brace.rods.minLength, 0)} mm${Number.isFinite(model.sliced.brace.rods.maxLength) && model.sliced.brace.rods.maxLength < 1e6 ? `, the concrete fits ${fmt(model.sliced.brace.rods.maxLength, 0)} mm` : ''}. `}
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

      <Section title="Chop Chop price" count="estimate">
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
            className="btn primary"
            onClick={() => {
              const m = fullModel();
              download(`${base}-fabrication.zip`, buildZip(m, project), 'application/zip');
              toast('Fabrication ZIP exported');
            }}
          >
            Everything (ZIP)
          </button>
          <button className="btn" onClick={plateZip}>
            Plate DXFs ({model.sliced.parts.length})
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
          DXF R12, mm. Layers CUT (red), ETCH (blue: part numbers + image lines), BEND. Curves are fitted as true arcs within {fmt(v.arcTolerance, 3)} mm; kerf {fmt(v.kerf, 2)} mm
          compensated. {MATERIAL_NAME[v.plateMaterial]} {fmt(v.thickness, 1)} mm.
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
