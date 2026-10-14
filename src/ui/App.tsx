import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPipeline, type Model } from '../core/pipeline';
import { useStore, type Tab } from '../state/store';
import { useAssets } from '../state/assets';
import { FullModelContext, ModelContext, fmt } from './model';
import Toolbar from './Toolbar';
import ParamPanel from './ParamPanel';
import Inspector from './Inspector';
import PlatesView from './PlatesView';
import NestView from './NestView';
import MouldView from './MouldView';
import UnfoldView from './UnfoldView';
import ImageView from './ImageView';
import GraphView from './GraphView';

const Viewport = lazy(() => import('./Viewport'));
const CompareView = lazy(() => import('./CompareView'));

const TABS: { id: Tab; label: string }[] = [
  { id: '3d', label: '3D' },
  { id: 'plates', label: 'Plates' },
  { id: 'nest', label: 'Nest' },
  { id: 'mould', label: 'Mould + pour' },
  { id: 'unfold', label: 'Unfold' },
  { id: 'image', label: 'Image' },
  { id: 'graph', label: 'Graph' },
  { id: 'compare', label: 'Compare' },
];

export default function App() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const assets = useAssets(project);
  const pipeline = useMemo(() => createPipeline(), []);
  const [model, setModelState] = useState<Model>(() => pipeline(project, assets, 'full'));
  // what the last edit actually rebuilt (the deferred pass that follows is often all cache hits)
  const work = useRef({ stages: 0, ms: 0 });
  const setModel = (m: Model) => {
    const rebuilt = m.stages.filter((s) => !s.cached);
    if (rebuilt.length) work.current = { stages: rebuilt.length, ms: m.totalMs };
    setModelState(m);
  };
  const fullTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // regenerate: fast pass on the next frame, full pass once edits settle
  useEffect(() => {
    const raf = requestAnimationFrame(() => setModel(pipeline(project, assets, 'fast')));
    clearTimeout(fullTimer.current);
    fullTimer.current = setTimeout(() => setModel(pipeline(project, assets, 'full')), 320);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, assets, pipeline]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
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

  const getFull = useMemo(() => () => pipeline(project, assets, 'full'), [pipeline, project, assets]);
  const errors = model.issues.filter((i) => i.severity === 'error').length;
  const warns = model.issues.filter((i) => i.severity === 'warn').length;

  return (
    <FullModelContext.Provider value={getFull}>
    <ModelContext.Provider value={model}>
      <div className="app">
        <Toolbar />
        <aside className="left">
          <ParamPanel />
        </aside>
        <main className="main">
          <nav className="tabs" role="tablist">
            {TABS.map((t, i) => (
              <button key={t.id} role="tab" aria-selected={ui.tab === t.id} className={`tab ${ui.tab === t.id ? 'active' : ''}`} onClick={() => setUi({ tab: t.id })} title={`${t.label} (${i + 1})`}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="view">
            <Suspense fallback={<div className="empty">Loading…</div>}>
              {ui.tab === '3d' && <Viewport />}
              {ui.tab === 'plates' && <PlatesView />}
              {ui.tab === 'nest' && <NestView />}
              {ui.tab === 'mould' && <MouldView />}
              {ui.tab === 'unfold' && <UnfoldView />}
              {ui.tab === 'image' && <ImageView />}
              {ui.tab === 'graph' && <GraphView />}
              {ui.tab === 'compare' && <CompareView />}
            </Suspense>
          </div>
        </main>
        <aside className="right">
          <Inspector />
        </aside>
        <footer className="statusbar">
          <span>{model.sliced.parts.length} parts</span>
          <span>{model.bom.sheets} sheet{model.bom.sheets === 1 ? '' : 's'}</span>
          <span style={{ color: errors ? 'var(--err)' : 'var(--ok)' }}>{errors} errors</span>
          <span style={{ color: warns ? 'var(--warn)' : undefined }}>{warns} warnings</span>
          <span>
            last edit rebuilt {work.current.stages} stage{work.current.stages === 1 ? '' : 's'} in {fmt(work.current.ms, 0)} ms{model.stale ? ' · updating checks…' : ''}
          </span>
          <span>mm</span>
        </footer>
        {ui.toast && <div className="toast">{ui.toast}</div>}
      </div>
    </ModelContext.Provider>
    </FullModelContext.Provider>
  );
}
