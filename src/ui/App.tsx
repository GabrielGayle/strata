import { useEffect, useMemo, useRef, useState } from 'react';
import { assemble, createDeferredPipeline, createFrontPipeline, deferredInput, type DeferredInput, type DeferredModel, type FrontModel, type Model } from '../core/pipeline';
import { DeferredWorker, sameInput, shareResult } from '../core/deferred';
import { useStore } from '../state/store';
import { activeLayout, TABS, useWorkspaces } from '../state/workspaces';
import { findTab, visibleTabs } from '../core/workspace';
import { useAssets } from '../state/assets';
import { FullModelContext, ModelContext, fmt } from './model';
import Toolbar from './Toolbar';
import ParamPanel from './ParamPanel';
import Inspector from './Inspector';
import SetupTabs from './SetupTabs';
import WorkspaceArea, { WorkspaceBar } from './Workspace';
import DropOverlay from './DropOverlay';
import HelpLayer, { HelpButton } from './Help';
import DesignBox from './DesignBox';
import { designShortcutFromKey } from './designShortcut';
import { useMapTerrainBuild } from './useMapTerrainBuild';


export default function App() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const assets = useAssets(project);
  useMapTerrainBuild();
  const layout = useWorkspaces(activeLayout);
  const reveal = useWorkspaces((s) => s.reveal);
  const front = useMemo(() => createFrontPipeline(), []);
  // the deferred stages run here only for the first frame, exports, and when workers are unavailable
  const local = useMemo(() => createDeferredPipeline(), []);
  // the latest front pass, and the last deferred result with the input it was computed from
  const latest = useRef<{ f: FrontModel; input: DeferredInput } | null>(null);
  const deferred = useRef<{ result: DeferredModel; input: DeferredInput } | null>(null);
  const [model, setModelState] = useState<Model>(() => {
    const f = front(project, assets);
    const input = deferredInput(f, project);
    latest.current = { f, input };
    deferred.current = { result: local(input, 'full'), input };
    return assemble(f, deferred.current.result);
  });
  const modelRef = useRef(model);
  // what the last edit actually rebuilt (the deferred pass that follows is often all cache hits)
  const work = useRef({ stages: 0, ms: 0 });
  const setModel = (m: Model) => {
    const rebuilt = m.stages.filter((s) => !s.cached);
    if (rebuilt.length) work.current = { stages: rebuilt.length, ms: m.totalMs };
    modelRef.current = m;
    setModelState(m);
  };
  const worker = useRef<DeferredWorker | null>(null);
  const localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showDeferred = (result: DeferredModel, input: DeferredInput) => {
    const shared = shareResult(deferred.current?.result ?? null, result);
    deferred.current = { result: shared, input };
    const now = latest.current!;
    setModel(assemble(now.f, shared, !sameInput(input, now.input)));
  };
  // no worker: the old way, on this thread once edits settle
  const runLocal = (input: DeferredInput) => {
    clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => {
      if (latest.current?.input === input) showDeferred(local(input, 'full'), input);
    }, 320);
  };

  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    let w: DeferredWorker;
    try {
      w = new DeferredWorker(
        new Worker(new URL('../core/deferred.worker.ts', import.meta.url), { type: 'module' }),
        // an older job's results still beat what's on screen; they stay marked as updating
        (_id, result, input) => showDeferred(result, input),
        (_id, input, fatal) => {
          if (fatal && worker.current === w) worker.current = null;
          if (latest.current?.input === input) runLocal(input);
        },
      );
    } catch {
      return;
    }
    worker.current = w;
    // catch up on anything edited before the worker was ready
    if (latest.current && deferred.current && !sameInput(latest.current.input, deferred.current.input)) w.run(latest.current.input);
    return () => {
      w.terminate();
      if (worker.current === w) worker.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // regenerate: the plates on the next frame, then checks, nesting, moulds and BOM in the worker
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const f = front(project, assets);
      const input = deferredInput(f, project);
      latest.current = { f, input };
      const d = deferred.current!;
      const fresh = sameInput(d.input, input);
      setModel(assemble(f, d.result, !fresh));
      if (fresh) return;
      if (worker.current) worker.current.run(input);
      else runLocal(input);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, assets, front]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const design = designShortcutFromKey(e.key, e, e.target);
      if (design === 'toggle') {
        e.preventDefault();
        setDesignOpen((o) => !o);
        return;
      }
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (!mod && /^[1-8]$/.test(e.key)) {
        setUi({ tab: TABS[Number(e.key) - 1].id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, setUi]);

  // asking for a tab (a click, a number key, a "show in 3D" button) brings it up in whichever pane holds it
  useEffect(() => reveal(ui.tab), [ui.tab, reveal]);
  // and the current tab is always one on screen, so asking for it again still works
  useEffect(() => {
    const now = activeLayout(useWorkspaces.getState()); // fresh, after the reveal above
    if (!visibleTabs(now).includes(ui.tab)) {
      const holder = findTab(now, ui.tab);
      if (holder) setUi({ tab: holder.active as typeof ui.tab });
    }
  }, [layout, ui.tab, setUi]);

  // exports want everything current: the model on screen when it is, else finish it here
  const getFull = useMemo(
    () => () => {
      const f = front(project, assets);
      const input = deferredInput(f, project);
      const d = deferred.current;
      return assemble(f, d && sameInput(d.input, input) ? d.result : local(input, 'full'), false);
    },
    [front, local, project, assets],
  );
  const [designOpen, setDesignOpen] = useState(false);
  const mapTerrain = useStore((s) => s.mapTerrain);
  const errors = model.issues.filter((i) => i.severity === 'error').length;
  const warns = model.issues.filter((i) => i.severity === 'warn').length;

  return (
    <FullModelContext.Provider value={getFull}>
    <ModelContext.Provider value={model}>
      <div className="app window">
        <div className="title-bar">
          <div className="title-bar-text">
            <span className="brand">
              <span className="mark" />
              STRATA
            </span>
          </div>
        </div>
        <Toolbar />
        <aside className="left window">
          <ParamPanel />
        </aside>
        <main className="main">
          <div className="main-head">
            <SetupTabs />
            <WorkspaceBar />
          </div>
          <WorkspaceArea />
        </main>
        <aside className="right window">
          <Inspector />
        </aside>
        <footer className="statusbar status-bar">
          <p className="status-bar-field">{model.sliced.parts.length} parts</p>
          <p className="status-bar-field">{model.bom.sheets} sheet{model.bom.sheets === 1 ? '' : 's'}</p>
          <p className="status-bar-field" style={{ color: errors ? 'var(--err)' : 'var(--ok)' }}>{errors} errors</p>
          <p className="status-bar-field" style={{ color: warns ? 'var(--warn)' : undefined }}>{warns} warnings</p>
          <p className="status-bar-field">
            last edit rebuilt {work.current.stages} stage{work.current.stages === 1 ? '' : 's'} in {fmt(work.current.ms, 0)} ms{model.stale ? ' · updating checks…' : ''}
          </p>
          {mapTerrain.phase !== 'idle' && (
            <p
              className="status-bar-field"
              style={{ color: mapTerrain.phase === 'error' ? 'var(--err)' : mapTerrain.phase === 'working' ? 'var(--accent)' : undefined }}
              title={mapTerrain.error ?? undefined}
            >
              {mapTerrain.message}{mapTerrain.error ? `: ${mapTerrain.error}` : ''}
            </p>
          )}
          <p className="status-bar-field">mm</p>
          <HelpButton />
        </footer>
        {ui.toast && (
          <div className="toast window" role="status">
            <div className="title-bar">
              <div className="title-bar-text">Strata</div>
            </div>
            <div className="window-body">{ui.toast}</div>
          </div>
        )}
        <DropOverlay />
        <HelpLayer />
        {designOpen && <DesignBox onClose={() => setDesignOpen(false)} />}
      </div>
    </ModelContext.Provider>
    </FullModelContext.Provider>
  );
}
