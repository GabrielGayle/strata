import { useEffect, useState } from 'react';
import type { NestJobRequest } from '../../api/_lib/geoJob.js';
import { nestSheetArea, type NestResult, type SavedNest } from '../core/nest';
import type { Model } from '../core/pipeline';
import type { PriceRates } from '../core/price';
import type { Project } from '../core/project';
import {
  checkCloud,
  cloudNest,
  cloudPack,
  CloudJobFailedError,
  CloudPackMismatchError,
  cloudStatusText,
  CloudUnavailableError,
  cloudUsage,
  setCloudNotice,
  useCloud,
  type CloudUsage,
} from '../state/cloud';

type NestJobBudget = NestJobRequest['budget'];

/** Status bar Cloud field: off, checking, locked, ready, working n%, resting: reason. */
export function CloudField() {
  const cloud = useCloud();
  // Boost left on from last time: one health check on start
  useEffect(() => {
    if (useCloud.getState().boost) void checkCloud();
  }, []);
  const color =
    cloud.boost && cloud.phase === 'working' ? 'var(--accent)' : cloud.boost && (cloud.phase === 'resting' || cloud.phase === 'locked') ? 'var(--warn)' : undefined;
  return (
    <p
      className="status-bar-field"
      data-testid="cloud-status"
      style={{ color }}
      title={cloud.boost ? 'Boost runs heavy jobs in the cloud (Settings). The local build is always the fallback.' : 'Boost is off: everything runs in this browser (Settings to turn it on)'}
    >
      {cloudStatusText(cloud)}
    </p>
  );
}

function money(n: number): string {
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** Settings section: the Boost switch, where it stands, and this month's cost. */
export function BoostSettings() {
  const cloud = useCloud();
  const [usage, setUsage] = useState<CloudUsage | null | undefined>(undefined);
  useEffect(() => {
    if (!cloud.boost || cloud.phase !== 'ready') return;
    let alive = true;
    void cloudUsage().then((u) => alive && setUsage(u));
    return () => {
      alive = false;
    };
  }, [cloud.boost, cloud.phase]);
  return (
    <>
      <label title="Off: everything runs in this browser with no network. On: heavy jobs (high-resolution maps) run on the cloud, with the local build as the fallback.">
        <input type="checkbox" data-testid="boost-toggle" checked={cloud.boost} onChange={(e) => cloud.setBoost(e.target.checked)} /> Boost (cloud jobs)
      </label>
      <p className="note" data-testid="boost-status">
        {cloudStatusText(cloud)}
        {cloud.boost && cloud.phase === 'locked' ? '. Enter the owner passphrase in Projects first.' : ''}
      </p>
      {cloud.boost && usage && (
        <p className="note" data-testid="boost-usage">
          {usage.month}: {usage.jobs} job{usage.jobs === 1 ? '' : 's'}, about {money(usage.estimateUsd)}
          {usage.workspaceUsd != null ? ` (Modal bill so far ${money(usage.workspaceUsd)} of the ${money(usage.grantUsd)} grant)` : ` of the ${money(usage.grantUsd)} monthly grant`}
        </p>
      )}
      {cloud.boost && cloud.phase === 'resting' && (
        <div className="btnrow">
          <button className="btn sm" onClick={() => void checkCloud()}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}

function jobCost(r: { seconds?: number; costUsd?: number; cached?: boolean }): string {
  if (r.cached) return 'from the cloud cache';
  const bits = [r.seconds != null ? `${r.seconds.toFixed(1)} s` : '', r.costUsd != null ? `about $${r.costUsd.toFixed(4)}` : ''].filter(Boolean);
  return bits.length ? bits.join(', ') : 'in the cloud';
}

function failure(e: unknown): string {
  if (e instanceof CloudJobFailedError && e.detail) return e.detail;
  if (e instanceof CloudUnavailableError) return e.message;
  return (e as Error).message || 'failed';
}

/** Toolbar: the fabrication zip built in the cloud (shown while Boost is on). */
export function CloudPackButton({ project, model, rates }: { project: () => Project; model: () => Model; rates: () => PriceRates }) {
  const cloud = useCloud();
  const [running, setRunning] = useState(false);
  if (!cloud.boost) return null;
  const go = async () => {
    setRunning(true);
    setCloudNotice(undefined);
    const p = project();
    const m = model();
    try {
      const r = await cloudPack(p, m, rates());
      const name = `${(p.name || 'strata').replace(/[^\w-]+/g, '_')}-fabrication.zip`;
      const url = URL.createObjectURL(new Blob([r.zip as BlobPart], { type: 'application/zip' }));
      setCloudNotice({
        kind: 'ok',
        text: `Cloud pack ready: ${m.sliced.plates.length} plates and ${m.sliced.parts.length} parts, matching this design (${(r.zip.length / 1048576).toFixed(1)} MB, ${jobCost(r)}).`,
        url,
        name,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setCloudNotice({
        kind: 'error',
        title: e instanceof CloudPackMismatchError ? 'Cloud pack refused' : 'Cloud pack failed',
        text:
          e instanceof CloudPackMismatchError
            ? `Cloud pack refused: ${e.message}. Nothing was downloaded; use Export ZIP.`
            : `Cloud pack failed: ${failure(e)}. Export ZIP still works here.`,
      });
    } finally {
      setRunning(false);
    }
  };
  const ready = cloud.phase === 'ready';
  return (
    <button
      className="tb"
      data-testid="cloud-pack"
      disabled={running || !ready}
      onClick={() => void go()}
      title={ready ? 'Build the same fabrication zip on the cloud, checked against this design before it downloads' : `Cloud ${cloudStatusText(cloud).replace(/^Cloud: /, '')}`}
    >
      {running ? 'Packing…' : 'Export (cloud)'}
    </button>
  );
}

/** The last cloud pack: a download link, or a red error. */
export function CloudNoticeWindow() {
  const notice = useCloud((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="window cloud-notice" role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="cloud-notice">
      <div className="title-bar">
        <div className="title-bar-text">{notice.title ?? 'Cloud pack'}</div>
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={() => setCloudNotice(undefined)} />
        </div>
      </div>
      <div className="window-body">
        <p className={notice.kind === 'error' ? 'note err' : 'note'}>{notice.text}</p>
        {notice.url && (
          <p>
            <a href={notice.url} download={notice.name} data-testid="cloud-pack-link">
              Download {notice.name}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

/** Cut sheets tab: ask the cloud for a tighter nest, and say which nest is in use. */
export function CloudNestBar({ project, model, nested, setNest }: { project: Project; model: () => Model; nested: NestResult; setNest: (n: SavedNest | undefined) => void }) {
  const cloud = useCloud();
  const [running, setRunning] = useState<NestJobBudget | null>(null);
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);
  const saved = project.nest;
  const inUse = nested.source === 'saved';
  if (!cloud.boost && !saved) return null;
  const go = async (budget: NestJobBudget) => {
    setRunning(budget);
    setMsg(null);
    try {
      const r = await cloudNest(project, model(), budget);
      setNest(r.nest);
      const area = nestSheetArea(r.nest.result);
      const less = r.nest.localArea ? (1 - area / r.nest.localArea) * 100 : 0;
      setMsg({ err: false, text: `Cloud nest: ${r.nest.result.sheets.length} sheets, ${less.toFixed(1)}% less sheet than the nest made here (${jobCost(r)}).` });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMsg({ err: true, text: `Cloud nest failed: ${failure(e)}. The nest made here stands.` });
    } finally {
      setRunning(null);
    }
  };
  const ready = cloud.boost && cloud.phase === 'ready';
  return (
    <div className="note" data-testid="cloud-nest">
      {saved && inUse && <span>Using the cloud's tight nest ({saved.budget === 'tight' ? '90 s' : '30 s'}). </span>}
      {saved && !inUse && <span>The saved cloud nest no longer matches these parts, so this is the nest made here. </span>}
      {msg && <span className={msg.err ? 'err' : undefined} style={msg.err ? { color: 'var(--err)' } : undefined}>{msg.text} </span>}
      <span className="seg">
        {cloud.boost && (
          <>
            <button className="btn sm" disabled={!ready || !!running} onClick={() => void go('default')} title="Nest these parts on the cloud for 30 seconds: never worse than the nest made here">
              {running === 'default' ? 'Nesting…' : 'Tight nest (cloud, 30 s)'}
            </button>
            <button className="btn sm" disabled={!ready || !!running} onClick={() => void go('tight')} title="The same for 90 seconds">
              {running === 'tight' ? 'Nesting…' : '90 s'}
            </button>
          </>
        )}
        {saved && (
          <button className="btn sm" onClick={() => setNest(undefined)} title="Drop the cloud nest and use the one made in this browser">
            Use local nest
          </button>
        )}
      </span>
    </div>
  );
}
