// Per-face "Auto dimension from depth": preview metric extents and apply plate params.
import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { fmt, useModel } from './model';
import type { DepthData } from '../core/depth';
import { previewAutoDimension, type DepthFace } from '../core/autoDimension';

type Slot = DepthFace;

export default function AutoDimensionControls({ slot, depth }: { slot: Slot; depth: DepthData }) {
  const project = useStore((s) => s.project);
  const setParams = useStore((s) => s.setParams);
  const model = useModel();
  const [exaggeration, setExaggeration] = useState(1);
  const [open, setOpen] = useState(false);

  const preview = useMemo(
    () => previewAutoDimension(slot, depth, project.params, { reliefExaggeration: exaggeration }),
    [slot, depth, project.params, exaggeration],
  );

  const plateNote = preview.ok
    ? `Plates now: ${fmt(model.v.plateCount, 0)} @ ${fmt(model.v.pitch, 1)} mm pitch, ${fmt(model.v.stackHeight, 0)} mm high`
    : '';

  return (
    <div className="depth-ctl auto-dim">
      <div className="field-row pm-row">
        <span>Auto dimension</span>
        <button type="button" className={`btn sm ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Estimate real extents from the depth map and preview plate changes">
          {open ? 'Hide preview' : 'From depth…'}
        </button>
      </div>
      {preview.ok ? (
        <div className="note mono" style={{ marginTop: 0 }}>
          {preview.readout}
          <span className="note"> (focal: {preview.extent.focalSource})</span>
        </div>
      ) : (
        <div className="note" style={{ color: 'var(--err)' }}>{preview.reason ?? 'Cannot auto-dimension'}</div>
      )}
      <label className="field-row pm-row" title="Scale relief vs true metric proportions (1 = as measured)">
        <span>Relief exaggeration</span>
        <input type="range" min={0.25} max={3} step={0.05} value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))} aria-label="Relief exaggeration" />
        <span className="mono">{exaggeration.toFixed(2)}×</span>
      </label>
      {open && preview.ok && (
        <div className="note" style={{ display: 'grid', gap: 4 }}>
          <div>{preview.note}</div>
          {preview.diff.length === 0 ? (
            <div>Parameters already match this depth extent.</div>
          ) : (
            <table className="mono" style={{ width: '100%', fontSize: '0.85em' }}>
              <thead>
                <tr>
                  <th align="left">Parameter</th>
                  <th align="right">Before</th>
                  <th align="right">After</th>
                </tr>
              </thead>
              <tbody>
                {preview.diff.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}{row.clamped ? ' ⚠' : ''}</td>
                    <td align="right">{row.before}</td>
                    <td align="right">{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.clamped.length > 0 && <div>Clamped: {preview.clamped.join(', ')}</div>}
          {plateNote && <div>{plateNote} (live price uses current params until you apply)</div>}
        </div>
      )}
      <div className="btnrow" style={{ padding: 0 }}>
        <button
          type="button"
          className="btn sm default"
          disabled={!preview.ok}
          onClick={() => {
            if (!preview.ok) return;
            setParams(preview.patch, `Auto dimension ${slot}`);
            setOpen(false);
          }}
        >
          Apply auto dimension
        </button>
      </div>
    </div>
  );
}
