import { useEffect, useMemo, useRef, useState } from 'react';
import { assemble, createDeferredPipeline, createFrontPipeline, deferredInput, type DeferredInput, type DeferredModel, type FrontModel, type Model } from '../core/pipeline';
import { EngineWorker, type EngineMode } from '../core/engine';
import type { Assets } from '../core/pipeline';
import type { Project } from '../core/project';
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
import { BusyLight, BusyWindows, useAppBusy } from './BusyWindow';
import { isMapTerrainFailure, reportMapTerrainFailure, reportMapTerrainMessage, runFrontPipelineSafe } from './mapTerrainError';
import { isMapDepth, mapMasterWidthMm, mapScaleMmPerM, mapTrueRangePlateMm } from '../core/mapPlateHeight';
import { flatStackHeightMm, flatStackIsCapped } from '../core/mapGeometryReadout';
import { countPlatesAtMaxHeight, plateTopHeightRangeMm } from '../core/slicer';

/** After a drag, how long the edits must rest before the full model is built. */
const FULL_AFTER_MS = 150;
const DEFERRED_KEYS = ['v', 'sliced', 'insert', 'pourRows', 'appearance'] as const;
const sameDeferredInput = (a: DeferredInput, b: DeferredInput) => DEFERRED_KEYS.every((k) => a[k] === b[k]);


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
  // the pipeline on this thread: the first frame, exports the engine hasn't caught up with, and browsers without workers
  const front = useMemo(() => createFrontPipeline(), []);
  const local = useMemo(() => createDeferredPipeline(), []);
  // the latest front pass, and the last deferred result with the input it was computed from (this-thread path)
  const latest = useRef<{ f: FrontModel; input: DeferredInput } | null>(null);
  const deferred = useRef<{ result: DeferredModel; input: DeferredInput } | null>(null);
  // the model on screen and what it was built from
  const shown = useRef<{ project: Project; assets: Assets; mode: EngineMode } | null>(null);
  const inputs = useRef({ project, assets });
  inputs.current = { project, assets };
  const [model, setModelState] = useState<Model>(() => {
    const f = runFrontPipelineSafe(front, project, assets);
    const input = deferredInput(f, project);
    latest.current = { f, input };
    deferred.current = { result: local(input, 'full'), input };
    shown.current = { project, assets, mode: 'full' };
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
  const engine = useRef<EngineWorker | null>(null);
  // what the engine worker is building right now, for the status bar light and the busy window
  const [engineBusy, setEngineBusy] = useState<EngineMode | null>(null);
  const runEngine = (w: EngineWorker, project: Project, assets: Assets, mode: EngineMode) => {
    lastMode.current = mode;
    w.run(project, assets, mode);
    setEngineBusy(mode);
  };
  const localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showDeferred = (result: DeferredModel, input: DeferredInput) => {
    deferred.current = { result, input };
    const now = latest.current!;
    setModel(assemble(now.f, result, !sameDeferredInput(input, now.input)));
  };
  // no engine worker: the old way, the plates on this thread on the next frame, then the rest once edits settle
  const runLocal = (project: Project, assets: Assets) => {
    const f = runFrontPipelineSafe(front, project, assets);
    const input = deferredInput(f, project);
    latest.current = { f, input };
    shown.current = { project, assets, mode: 'full' };
    const d = deferred.current!;
    const fresh = sameDeferredInput(d.input, input);
    setModel(assemble(f, d.result, !fresh));
    if (fresh) return;
    clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => {
      if (latest.current?.input !== input) return;
      try {
        showDeferred(local(input, 'full'), input);
      } catch (e) {
        if (isMapTerrainFailure(e)) reportMapTerrainFailure(e);
        else throw e;
      }
    }, 320);
  };

  // while a pointer is down (a slider or gizmo being dragged) the engine builds a coarse preview;
  // the full model follows FULL_AFTER_MS after the last change once it is let go
  const held = useRef(false);
  const lastMode = useRef<EngineMode>('full');
  const fullTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleFull = () => {
    clearTimeout(fullTimer.current);
    fullTimer.current = setTimeout(() => {
      if (held.current || lastMode.current === 'full' || !engine.current) return;
      runEngine(engine.current, inputs.current.project, inputs.current.assets, 'full');
    }, FULL_AFTER_MS);
  };
  useEffect(() => {
    const down = () => (held.current = true);
    const up = () => {
      held.current = false;
      if (lastMode.current === 'preview') scheduleFull();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    let w: EngineWorker;
    try {
      w = new EngineWorker(
        new Worker(new URL('../core/engine.worker.ts', import.meta.url), { type: 'module' }),
        (job, m, reply) => {
          setEngineBusy(w.working ? lastMode.current : null);
          if (reply.mapError) reportMapTerrainMessage(reply.mapError);
          const s = shown.current;
          // the warm-up pass (and any repeat of what is on screen) changes nothing
          if (s && s.mode === 'full' && job.mode === 'full' && s.project === job.project && s.assets === job.assets) return;
          shown.current = { project: job.project, assets: job.assets, mode: job.mode };
          // an older job's model still beats what's on screen; it stays marked as updating
          setModel({ ...m, stale: m.stale || job.mode === 'preview' || w.working });
        },
        (job, fatal, error) => {
          setEngineBusy(null);
          if (fatal && engine.current === w) engine.current = null;
          console.error('Strata engine worker:', error);
          // run it here instead (an error in the pipeline itself shows the same way it always has)
          if (job.project === inputs.current.project && job.assets === inputs.current.assets) runLocal(job.project, job.assets);
        },
      );
    } catch {
      return;
    }
    engine.current = w;
    // warm the worker's caches with what is on screen, and catch up on anything edited meanwhile (quietly: it changes nothing on screen)
    w.run(inputs.current.project, inputs.current.assets, 'full');
    return () => {
      w.terminate();
      if (engine.current === w) engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // regenerate: in the engine worker when there is one, else on this thread
  useEffect(() => {
    const s = shown.current;
    if (s && s.project === project && s.assets === assets) return;
    if (engine.current) {
      const mode: EngineMode = held.current ? 'preview' : 'full';
      runEngine(engine.current, project, assets, mode);
      if (mode === 'preview') scheduleFull();
      return;
    }
    const raf = requestAnimationFrame(() => runLocal(project, assets));
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
      const { project, assets } = inputs.current;
      const s = shown.current;
      const m = modelRef.current;
      if (s && s.mode === 'full' && s.project === project && s.assets === assets && !m.stale) return m;
      const f = runFrontPipelineSafe(front, project, assets);
      const input = deferredInput(f, project);
      const d = deferred.current;
      try {
        return assemble(f, d && sameDeferredInput(d.input, input) ? d.result : local(input, 'full'), false);
      } catch (e) {
        if (isMapTerrainFailure(e)) {
          reportMapTerrainFailure(e);
          return assemble(f, d && sameDeferredInput(d.input, input) ? d.result : local(input, 'fast'), false);
        }
        throw e;
      }
    },
    [front, local],
  );
  const [designOpen, setDesignOpen] = useState(false);
  const mapTerrain = useStore((s) => s.mapTerrain);
  useAppBusy(!!model.stale, engineBusy);
  const errors = model.issues.filter((i) => i.severity === 'error').length;
  const warns = model.issues.filter((i) => i.severity === 'warn').length;
  const stackRodCount = model.sliced.stackRods?.rods.length ?? 0;
  const stackRodsVisible = ui.viewportLayers.rods !== false && stackRodCount > 0;
  const topDepth = project.images.top?.depth;
  const mapFace = isMapDepth(topDepth) && !!project.images.top?.map;
  const mapEx = Number(project.images.top?.map?.exaggerationFactor) || 0;
  const mapRelief = topDepth?.mapOrtho?.reliefM;
  const mapScale = topDepth?.mapOrtho ? mapScaleMmPerM(topDepth.mapOrtho.widthM, mapMasterWidthMm(model.v)) : 0;
  const expectedMm = mapFace && topDepth ? mapTrueRangePlateMm(topDepth, model.v, mapEx || 1) : 0;
  const stackMm = flatStackHeightMm(model.sliced.plates.length, model.v.thickness);
  const terrainTopMm = model.hf?.max;
  const stackCapped = mapFace && model.v.sliceMode === 'flat' && flatStackIsCapped(terrainTopMm, model.sliced.plates.length, model.v.thickness);
  // Flat outlines live in plan (x, −z); their Y span is the footprint, not the
  // laminated height. Report n×thickness so ×11 and ×21 are not a coincidental
  // ~160 mm plan reading while the stack stays capped at 20 × 3 mm.
  const plateRangeMm = mapFace
    ? model.v.sliceMode === 'flat'
      ? stackMm
      : plateTopHeightRangeMm(model.sliced.plates)
    : 0;
  const mapZMaxM = topDepth?.mapOrtho?.zMaxM;
  const platesAtMax = mapFace ? countPlatesAtMaxHeight(model.sliced.plates) : 0;
  // the model on screen is the full one for the current project (it lags edits while the engine works)
  const modelCurrent = shown.current?.mode === 'full' && shown.current.project === project && shown.current.assets === assets && !model.stale;

  return (
    <FullModelContext.Provider value={getFull}>
    <ModelContext.Provider value={model}>
      <div
        className="app window"
        data-strata-map-phase={mapTerrain.phase}
        data-strata-map-error={mapTerrain.phase === 'error' ? (mapTerrain.error || mapTerrain.message || 'map terrain error') : undefined}
        data-strata-map-relief-m={mapFace && mapRelief != null ? String(mapRelief) : undefined}
        data-strata-map-exaggeration={mapFace && mapEx ? String(mapEx) : undefined}
        data-strata-map-scale-mm-per-m={mapFace && mapScale ? String(mapScale) : undefined}
        data-strata-map-expected-height-mm={mapFace ? String(expectedMm) : undefined}
        data-strata-plate-height-range-mm={mapFace ? String(plateRangeMm) : undefined}
        data-strata-map-terrain-top-mm={mapFace && terrainTopMm != null ? String(terrainTopMm) : undefined}
        data-strata-map-stack-capped={mapFace && model.v.sliceMode === 'flat' ? (stackCapped ? '1' : '0') : undefined}
        data-strata-map-z-max-m={mapFace && mapZMaxM != null ? String(mapZMaxM) : undefined}
        data-strata-plates-at-max={mapFace ? String(platesAtMax) : undefined}
        data-strata-model-current={modelCurrent ? '1' : '0'}
        data-strata-slice-mode={model.v.sliceMode}
        data-strata-stack-rods={String(stackRodCount)}
        data-strata-stack-rods-visible={stackRodsVisible ? '1' : '0'}
      >
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
          <p className="status-bar-field" data-testid="status-counts">
            {model.sliced.plates.length} plates · {model.sliced.parts.length} parts
          </p>
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
          <BusyLight />
          <p className="status-bar-field">mm</p>
          <HelpButton />
        </footer>
        <BusyWindows />
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
