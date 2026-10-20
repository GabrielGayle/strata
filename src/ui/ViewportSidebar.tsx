// The 3D view's sidebar, after Blender's N panel: the tool windows that used
// to float over the view (candles, postcard shelf, objects, materials, move
// plates, measuring tape) dock here instead, one tab each. The view gets
// narrower rather than covered. The tabs stand on the right edge even when the
// sidebar is shut; N opens and shuts it, the left edge drags it wider.
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useStore } from '../state/store';
import ObjectsPanel from './ObjectsPanel';
import { DEFAULT_W, MIN_W, openSideTab, rememberSidebar, sidebarIsOpen, useSidebar, useSideTab, type SideTab } from './sidebarState';
import { UnobstructedDevDock } from './ShelfPanel';
import AppearancePanel from './AppearancePanel';
import { MeasurePanel } from './Measure';
import { Fold } from './Fold';

interface TabDef {
  id: SideTab;
  label: string;
  title: string;
}

/** The sidebar itself. `move` is the Move plates panel, which lives with the viewport. */
export default function ViewportSidebar({ move, parked, counts }: { move: ReactNode; parked: boolean; counts: { objects: number; moved: number; bucketed: number } }) {
  const tab = useSideTab();
  const candles = useStore((s) => !!s.project.candles);
  const shelf = useStore((s) => !!s.project.shelf);
  const width = useSidebar((s) => s.width);
  const asideRef = useRef<HTMLElement | null>(null);

  // N opens the sidebar on the last tab, or shuts it (Blender's key for its sidebar)
  useEffect(() => {
    if (parked) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      openSideTab(sidebarIsOpen(useStore.getState().ui) ? null : useSidebar.getState().last);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parked]);

  // drag the left edge to make it wider or narrower; the 3D view always keeps at least a third
  const onEdgeDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const aside = asideRef.current;
    const host = aside?.parentElement;
    if (!aside || !host) return;
    const startX = e.clientX;
    const startW = aside.offsetWidth;
    const max = () => Math.max(MIN_W, host.clientWidth * 0.66);
    const move = (ev: PointerEvent) => useSidebar.setState({ width: Math.round(Math.min(max(), Math.max(MIN_W, startW + startX - ev.clientX))) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('vs-resizing');
      rememberSidebar({});
    };
    document.body.classList.add('vs-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);
  const resetWidth = () => rememberSidebar({ width: DEFAULT_W });

  const n = (x: number) => (x ? ` (${x})` : '');
  const tabs: TabDef[] = [
    { id: 'candles', label: 'Candles', title: 'Candelabra: candlesticks and tealights along a curve, a path or a shape, the plates rising to hold them' },
    { id: 'shelf', label: 'Shelf', title: 'Postcard shelf: a list of postcards laid along an arc, each held in a notch' },
    { id: 'objects', label: `Objects${n(counts.objects)}`, title: 'Place postcards, boxes and other objects; each is cut out of the plates it passes through' },
    { id: 'materials', label: `Materials${n(counts.bucketed)}`, title: 'Material buckets: click plates to choose what each is cut from (shift-click a run)' },
    { id: 'move', label: `Move plates${n(counts.moved)}`, title: 'Click a plate, then drag the gizmo to move or turn it (W move, E rotate, Q world / local)' },
    { id: 'measure', label: 'Measure', title: 'Measuring tape: point to point, edge to edge, point to edge or face (M; Esc leaves)' },
  ];
  const cur = tabs.find((t) => t.id === tab);

  return (
    <aside ref={asideRef} className={`vp-sidebar${tab ? ' open' : ''}`} style={tab ? { width } : undefined} aria-label="3D view sidebar" data-testid="viewport-sidebar">
      {tab && (
        <>
          <div className="vs-edge" onPointerDown={onEdgeDown} onDoubleClick={resetWidth} title="Drag to make the sidebar wider or narrower. Double-click for the usual width." aria-hidden="true" />
          <div className="vs-main window">
            <div className="title-bar">
              <div className="title-bar-text">{cur?.label.replace(/ \(\d+\)$/, '')}</div>
              <div className="title-bar-controls">
                <button aria-label="Close" onClick={() => openSideTab(null)} title="Shut the sidebar (N). What you made stays; the tabs on the right open it again."></button>
              </div>
            </div>
            <div className="vs-body">
              {(tab === 'candles' || tab === 'shelf' || tab === 'objects') && (
                <>
                  <ObjectsPanel view={tab} />
                  {tab === 'shelf' && <UnobstructedDevDock />}
                </>
              )}
              {tab === 'materials' && (
                <Fold id="materials" title="Material buckets">
                  <AppearancePanel />
                </Fold>
              )}
              {tab === 'move' && <Fold id="move" title="Move and turn plates">{move}</Fold>}
              {tab === 'measure' && (
                <Fold id="measure" title="Measuring tape">
                  <MeasurePanel />
                </Fold>
              )}
            </div>
          </div>
        </>
      )}
      <div className="vs-tabs" role="tablist" aria-orientation="vertical" aria-label="Sidebar tabs (N)">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`vs-tab${tab === t.id ? ' on' : ''}${(t.id === 'candles' && candles) || (t.id === 'shelf' && shelf) ? ' used' : ''}`}
            data-testid={`sidebar-tab-${t.id}`}
            onClick={() => openSideTab(tab === t.id ? null : t.id)}
            title={`${t.title}. Click again to shut the sidebar (N).`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </aside>
  );
}
