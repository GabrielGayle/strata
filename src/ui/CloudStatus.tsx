import { useEffect, useMemo, useState } from 'react';
import { HERO_DAILY_LIMIT, HERO_MAX_SECONDS, HERO_PX, heroPrice, type HeroJobRequest, type NestJobRequest } from '../../api/_lib/geoJob.js';
import { HERO_LIGHTS, heroFingerprint, type SavedHero } from '../core/hero';
import { nestSheetArea, type NestResult, type SavedNest } from '../core/nest';
import type { Model } from '../core/pipeline';
import type { PriceRates } from '../core/price';
import type { Project } from '../core/project';
import { getLiveCamera } from './liveView';
import { useStore } from '../state/store';
import { useModel } from './model';
import {
  checkCloud,
  cloudHero,
  CloudHeroMismatchError,
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

type HeroLightId = HeroJobRequest['light'];

/** Toolbar: a photograph of the finished piece, rendered on the cloud (shown while Boost is on or a render is saved). */
export function CloudHeroButton({ project, model, setHero }: { project: () => Project; model: () => Model; setHero: (h: SavedHero | undefined) => void }) {
  const cloud = useCloud();
  const [open, setOpen] = useState(false);
  const saved = useStore((s) => s.project.hero);
  if (!cloud.boost && !saved) return null;
  return (
    <>
      <button className={`tb ${open ? 'on' : ''}`} data-testid="hero-open" onClick={() => setOpen((o) => !o)} title="A photograph of the finished piece, rendered with Blender on a cloud GPU, for the build pack">
        Hero render
      </button>
      {open && <HeroWindow project={project} model={model} setHero={setHero} close={() => setOpen(false)} />}
    </>
  );
}

function HeroWindow({ project, model, setHero, close }: { project: () => Project; model: () => Model; setHero: (h: SavedHero | undefined) => void; close: () => void }) {
  const cloud = useCloud();
  const p = useStore((s) => s.project);
  // the model on screen, once the engine has caught up (a drag shows a coarser preview first)
  const shown = useModel();
  const m = shown.stale ? null : shown;
  const hasCandles = shown.objects.some(({ object: o }) => o.on !== false && (o.look === 'candle' || o.look === 'tealight'));
  const [light, setLight] = useState<HeroLightId>(() => p.hero?.light ?? (hasCandles ? 'candle' : 'studio'));
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const saved = p.hero;
  const current = useMemo(() => (saved && m ? heroFingerprint(m, p) === saved.fingerprint : undefined), [saved, m, p]);
  const ready = cloud.boost && cloud.phase === 'ready';
  useEffect(() => {
    if (!ready || running) return;
    let alive = true;
    void cloudUsage().then((u) => alive && setUsage(u));
    return () => {
      alive = false;
    };
  }, [ready, running]);
  const limit = usage?.heroLimit ?? HERO_DAILY_LIMIT;
  const left = usage?.heroToday != null ? Math.max(0, limit - usage.heroToday) : null;
  const price = heroPrice();
  const cam = getLiveCamera();
  const size = (() => {
    const a = cam?.aspect ?? 1.5;
    return a >= 1 ? `${HERO_PX} × ${Math.round(HERO_PX / a)}` : `${Math.round(HERO_PX * a)} × ${HERO_PX}`;
  })();
  const go = async () => {
    const c = getLiveCamera();
    if (!c) {
      setMsg({ err: true, text: 'Open the 3D view first: the render uses its camera.' });
      return;
    }
    setRunning(true);
    setMsg(null);
    try {
      const r = await cloudHero(project(), model(), { position: c.position, target: c.target, up: c.up, fov: c.fov, aspect: c.aspect }, light);
      setHero(r.hero);
      setMsg({ err: false, text: `Rendered ${r.hero.w} × ${r.hero.h} px (${jobCost(r)}). It is in the build pack.` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (e instanceof CloudHeroMismatchError) setMsg({ err: true, text: `Render refused: ${e.message}. Nothing was saved.` });
      else if (e instanceof CloudUnavailableError && e.reason === 'limit') setMsg({ err: true, text: `That's the ${limit} renders for today; the next one can start tomorrow.` });
      else setMsg({ err: true, text: `Render failed: ${failure(e)}.` });
    } finally {
      setRunning(false);
    }
  };
  const download = () => {
    if (!saved) return;
    const a = document.createElement('a');
    a.href = saved.png;
    a.download = `${(p.name || 'strata').replace(/[^\w-]+/g, '_')}-hero.png`;
    a.click();
  };
  return (
    <div className="window hero-window" role="dialog" aria-label="Hero render" data-testid="hero-window">
      <div className="title-bar">
        <div className="title-bar-text">Hero render</div>
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={close} />
        </div>
      </div>
      <div className="window-body">
        {saved && (
          <figure className="hero-preview">
            <img src={saved.png} alt={`Hero render of ${p.name || 'this design'}`} width={saved.w} height={saved.h} />
            <figcaption className="note" data-testid="hero-state">
              {current === undefined
                ? 'Checking it still shows this design…'
                : current
                ? `${HERO_LIGHTS.find((l) => l.id === saved.light)?.label ?? 'Studio'}, ${saved.date}. In the build pack.`
                : 'Out of date: the design has changed since this render, so the build pack leaves it out.'}
            </figcaption>
          </figure>
        )}
        <fieldset className="section">
          <legend>New render</legend>
          <div className="field-row">
            <label htmlFor="hero-light">Light</label>
            <select id="hero-light" data-testid="hero-light" value={light} onChange={(e) => setLight(e.target.value as HeroLightId)} disabled={running}>
              {HERO_LIGHTS.filter((l) => l.id !== 'candle' || hasCandles).map((l) => (
                <option key={l.id} value={l.id} title={l.title}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <p className="note">
            The 3D view as it is now{cam?.ortho ? ' (rendered with perspective)' : ''}, {size} px, Blender Cycles on a cloud GPU.
          </p>
          <p className="note" data-testid="hero-price">
            About {money(price.typicalUsd)} a render, never more than {money(price.maxUsd)} (it stops at {HERO_MAX_SECONDS / 60} minutes).{' '}
            {left != null ? `${left} of ${limit} left today.` : `Up to ${limit} a day.`}
          </p>
          {msg && (
            <p className="note" role={msg.err ? 'alert' : 'status'} style={msg.err ? { color: 'var(--err)' } : undefined} data-testid="hero-msg">
              {msg.text}
            </p>
          )}
          <div className="btnrow">
            <button className="btn" data-testid="hero-render" disabled={!ready || running || left === 0} onClick={() => void go()} title={ready ? undefined : cloudStatusText(cloud)}>
              {running ? `Rendering… ${Math.round(cloud.progress * 100)}%` : `Render (about ${money(price.typicalUsd)})`}
            </button>
            {saved && (
              <>
                <button className="btn" onClick={download} data-testid="hero-download">
                  Download PNG
                </button>
                <button className="btn" onClick={() => setHero(undefined)} title="Take the render out of the project and the build pack">
                  Remove
                </button>
              </>
            )}
          </div>
          {!cloud.boost && <p className="note">Turn on Boost in Settings to render again.</p>}
        </fieldset>
      </div>
    </div>
  );
}
