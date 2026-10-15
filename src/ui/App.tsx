import { useEffect, useMemo, useRef, useState } from 'react';
import { createPipeline, type Model } from '../core/pipeline';
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


export default function App() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const assets = useAssets(project);
  const layout = useWorkspaces(activeLayout);
  const reveal = useWorkspaces((s) => s.reveal);
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
          <div className="main-head">
            <SetupTabs />
            <WorkspaceBar />
          </div>
          <WorkspaceArea />
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
