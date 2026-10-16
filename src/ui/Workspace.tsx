// The main area as a workspace: view tabs in panes you can split side by side
// or stacked, float over the rest, and save as named workspaces. Drag a tab
// onto the middle of a pane to join it, onto an edge to split, or use the
// pane's buttons (which also work on touch screens).
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ComponentType, type DragEvent, type LazyExoticComponent, type PointerEvent as RPointerEvent } from 'react';
import { zoneAt, type Float, type LayoutNode, type Pane, type Zone } from '../core/workspace';
import { useStore, type Tab } from '../state/store';
import { activeLayout, PRESETS, TABS, useWorkspaces } from '../state/workspaces';
import { Menu } from './Toolbar';
import { ViewportParkedContext } from './viewportStability';

// Every view loads on first open (the 3D one included), so the first screen only
// waits for the views it shows. Hovering a tab starts fetching its view early.
const LOAD: Record<Tab, () => Promise<{ default: ComponentType }>> = {
  '3d': () => import('./Viewport'),
  plates: () => import('./PlatesView'),
  nest: () => import('./NestView'),
  mould: () => import('./MouldView'),
  unfold: () => import('./UnfoldView'),
  image: () => import('./ImageView'),
  map: () => import('./MapView'),
  shadow: () => import('./ShadowView'),
  graph: () => import('./GraphView'),
  nodes: () => import('./NodesView'),
  compare: () => import('./CompareView'),
};
const VIEWS = Object.fromEntries(Object.entries(LOAD).map(([t, load]) => [t, lazy(load)])) as Record<Tab, LazyExoticComponent<ComponentType>>;
/** Start fetching a view before it is opened (repeat calls are free). */
export const preloadView = (t: string) => {
  LOAD[t as Tab]?.().catch(() => {});
};
const label = (t: string) => TABS.find((x) => x.id === t)?.label ?? t;
const keyOf = (t: string) => TABS.findIndex((x) => x.id === t) + 1;

const MIME = 'text/x-strata-tab';
const DragCtx = createContext<{ tab: string | null; setTab: (t: string | null) => void; area: { w: number; h: number } }>({ tab: null, setTab: () => {}, area: { w: 0, h: 0 } });

export default function WorkspaceArea() {
  const layout = useWorkspaces(activeLayout);
  const [tab, setTab] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setArea((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!tab) return;
    // a drag that ends anywhere (even outside the window) clears the drop targets
    const end = () => setTab(null);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, [tab]);
  return (
    <DragCtx.Provider value={{ tab, setTab, area }}>
      <div className={`ws-area ${tab ? 'dragging' : ''}`} ref={ref}>
        <Node node={layout.root} />
        {layout.floats.map((f) => (
          <FloatPane key={f.id} f={f} />
        ))}
      </div>
    </DragCtx.Provider>
  );
}

function Node({ node }: { node: LayoutNode }) {
  if (node.kind === 'pane') return <PaneView pane={node} />;
  return <SplitView node={node} />;
}

function SplitView({ node }: { node: Extract<LayoutNode, { kind: 'split' }> }) {
  const resize = useWorkspaces((s) => s.resize);
  const box = useRef<HTMLDivElement>(null);
  const onDown = (e: RPointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const r = box.current!.getBoundingClientRect();
    // side-by-side panes stack on narrow screens, so follow what is actually on screen
    const across = getComputedStyle(box.current!).flexDirection === 'row';
    const move = (ev: PointerEvent) => resize(node.id, across ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={`ws-split ${node.dir}`} ref={box}>
      <div className="ws-cell" style={{ flex: `${node.ratio} 1 0` }}>
        <Node node={node.a} />
      </div>
      <div
        className="ws-divider"
        role="separator"
        aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
        title="Drag to resize · double-click to even out"
        onPointerDown={onDown}
        onDoubleClick={() => resize(node.id, 0.5)}
      />
      <div className="ws-cell" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <Node node={node.b} />
      </div>
    </div>
  );
}

function TabStrip({ p }: { p: Pane | Float }) {
  const setUi = useStore((s) => s.setUi);
  const drag = useContext(DragCtx);
  return (
    <menu className="ws-tabs" role="tablist">
      {p.tabs.map((t) => (
        <li
          key={t}
          role="tab"
          draggable
          aria-selected={p.active === t}
          onClick={() => setUi({ tab: t as Tab })}
          onPointerEnter={() => preloadView(t)}
          onFocus={() => preloadView(t)}
          onDragStart={(e) => {
            e.dataTransfer.setData(MIME, t);
            e.dataTransfer.effectAllowed = 'move';
            // let the browser grab the drag image before the drop targets cover the view
            requestAnimationFrame(() => drag.setTab(t));
          }}
          title={`${label(t)} (${keyOf(t)}) · drag to another pane, or onto an edge to split`}
        >
          <a
            href={`#${t}`}
            onClick={(e) => e.preventDefault()}
          >
            {label(t)}
          </a>
        </li>
      ))}
    </menu>
  );
}

/** Drop targets laid over a pane while a tab is being dragged. */
function DropZones({ id }: { id: string }) {
  const move = useWorkspaces((s) => s.move);
  const setUi = useStore((s) => s.setUi);
  const drag = useContext(DragCtx);
  const [zone, setZone] = useState<Zone | null>(null);
  if (!drag.tab) return null;
  const at = (e: DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return zoneAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  return (
    <div
      className="ws-drop"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const z = at(e);
        if (z !== zone) setZone(z);
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        e.preventDefault();
        const t = e.dataTransfer.getData(MIME) || drag.tab;
        if (t) {
          move(t, { pane: id, zone: at(e) });
          setUi({ tab: t as Tab });
        }
        drag.setTab(null);
      }}
    >
      {zone && <div className={`ws-hint ${zone}`} />}
    </div>
  );
}

function PaneBody({ p }: { p: Pane | Float }) {
  const View = VIEWS[p.active as Tab];
  const show3d = p.active === '3d';
  const has3d = p.tabs.includes('3d');
  const [keep3d, setKeep3d] = useState(show3d);
  useEffect(() => {
    if (show3d) setKeep3d(true);
    if (!has3d) setKeep3d(false);
  }, [show3d, has3d]);
  const Three = VIEWS['3d'];
  return (
    <div className="view">
      {keep3d && has3d && (
        <Suspense fallback={show3d ? <div className="empty">Loading…</div> : null}>
          <ViewportParkedContext.Provider value={!show3d}>
            <div className={`view-layer${show3d ? '' : ' parked'}`} data-testid="viewport-3d">
              <Three />
            </div>
          </ViewportParkedContext.Provider>
        </Suspense>
      )}
      {p.active !== '3d' && (
        <Suspense fallback={<div className="empty">Loading…</div>}>{View && <View />}</Suspense>
      )}
      <DropZones id={p.id} />
    </div>
  );
}

function PaneView({ pane }: { pane: Pane }) {
  const move = useWorkspaces((s) => s.move);
  const floatCount = useWorkspaces((s) => activeLayout(s).floats.length);
  const { area } = useContext(DragCtx);
  const one = pane.tabs.length < 2;
  const splitOff = (zone: Zone) => move(pane.active, { pane: pane.id, zone });
  return (
    <section className="ws-pane">
      <header className="ws-head">
        <TabStrip p={pane} />
        <span className="ws-tools">
          <button className="ibtn" disabled={one} onClick={() => splitOff('right')} title={one ? 'Only one tab here' : `Split: show ${label(pane.active)} beside the others`} aria-label="Split right">
            ◧
          </button>
          <button className="ibtn" disabled={one} onClick={() => splitOff('bottom')} title={one ? 'Only one tab here' : `Split: show ${label(pane.active)} below the others`} aria-label="Split down">
            ⬓
          </button>
          <button
            className="ibtn"
            onClick={() => move(pane.active, { float: { x: Math.max(0, area.w - 560 - floatCount * 24), y: 40 + floatCount * 24 } })}
            title={`Float ${label(pane.active)} in its own window over the others`}
            aria-label="Float"
          >
            ⧉
          </button>
        </span>
      </header>
      <PaneBody p={pane} />
    </section>
  );
}

function FloatPane({ f }: { f: Float }) {
  const setFloat = useWorkspaces((s) => s.setFloat);
  const dock = useWorkspaces((s) => s.dock);
  const raise = useWorkspaces((s) => s.raise);
  const { area } = useContext(DragCtx);
  // keep at least the title bar reachable when the window shrinks
  const w = Math.min(f.w, Math.max(200, area.w));
  const h = Math.min(f.h, Math.max(140, area.h));
  const x = Math.max(0, Math.min(f.x, area.w - 80));
  const y = Math.max(0, Math.min(f.y, area.h - 32));
  const dragFrom = (e: RPointerEvent, mode: 'move' | 'size') => {
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = { x, y, w, h };
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (mode === 'move') setFloat(f.id, { x: start.x + dx, y: start.y + dy });
      else setFloat(f.id, { w: Math.max(200, start.w + dx), h: Math.max(140, start.h + dy) });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <section className="ws-pane ws-float window" style={{ left: x, top: y, width: w, height: h }} onPointerDownCapture={() => raise(f.id)}>
      <header className="title-bar ws-grab" onPointerDown={(e) => dragFrom(e, 'move')}>
        <div className="title-bar-text">{label(f.active as Tab)}</div>
        <div className="title-bar-controls">
          <button aria-label="Restore" onClick={() => dock(f.id)} title="Dock: put these tabs back in the main pane"></button>
        </div>
      </header>
      <div className="ws-head">
        <TabStrip p={f} />
      </div>
      <PaneBody p={f} />
      <div className="ws-size" onPointerDown={(e) => dragFrom(e, 'size')} title="Drag to resize" />
    </section>
  );
}

/** Pick, save and manage workspaces. */
export function WorkspaceBar() {
  const list = useWorkspaces((s) => s.list);
  const active = useWorkspaces((s) => s.active);
  const ws = useWorkspaces.getState;
  const cur = list.find((w) => w.id === active)!;
  const missingPresets = PRESETS.some((p) => !list.some((w) => w.id === p.id));
  return (
    <div className="ws-bar">
      <label className="ws-pick" title="Workspace: how the views are arranged. Changes are kept as you go.">
        <span>Workspace</span>
        <select value={active} onChange={(e) => ws().switchTo(e.target.value)} aria-label="Workspace">
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <Menu label="⋯" className="ws-menu">
        {(close) => (
          <>
            <button
              className="item"
              onClick={() => {
                close();
                const name = window.prompt('Name for the new workspace', `${cur.name} copy`);
                if (name) ws().saveAs(name);
              }}
            >
              Save as new workspace… <small>a copy of this arrangement</small>
            </button>
            <button
              className="item"
              onClick={() => {
                close();
                const name = window.prompt('Rename workspace', cur.name);
                if (name) ws().rename(cur.id, name);
              }}
            >
              Rename…
            </button>
            <button
              className="item"
              onClick={() => {
                ws().reset();
                close();
              }}
            >
              Reset layout <small>{cur.preset ? `back to the starting ${PRESETS.find((p) => p.id === cur.preset)?.name ?? ''} layout` : 'all tabs in one pane'}</small>
            </button>
            {list.length > 1 && (
              <button
                className="item"
                onClick={() => {
                  close();
                  if (window.confirm(`Delete the workspace "${cur.name}"?`)) ws().remove(cur.id);
                }}
              >
                Delete this workspace
              </button>
            )}
            {missingPresets && (
              <button
                className="item"
                onClick={() => {
                  ws().restorePresets();
                  close();
                }}
              >
                Bring back starting workspaces <small>{PRESETS.map((p) => p.name).join(', ')}</small>
              </button>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}
