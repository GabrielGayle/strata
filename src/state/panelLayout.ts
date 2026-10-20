// The panel layout store: where every panel and control sits, kept as you go
// (per browser, never in a project), plus named layouts you can save, load,
// export and reset. A saved layout also keeps the view workspace and the 3D
// sidebar's width, so loading one puts the whole screen back.
import { create } from 'zustand';
import { GROUPS, PARAMS, SWITCH_IDS } from '../core/params';
import {
  addCustom,
  defaultLayout,
  moveControl,
  movePanel,
  moveSideTab,
  normaliseLayout,
  nudgeControl,
  nudgePanel,
  removeCustom,
  renameCustom,
  resetPanel,
  sendHome,
  type Known,
  type PanelLayout,
  type Side,
} from '../core/panelLayout';
import { normalise, uid, type Layout } from '../core/workspace';
import { ALL_TABS, useWorkspaces, activeLayout } from './workspaces';

/** The Inspector column's panels, top to bottom. */
export const INSPECTOR_PANELS = [
  { id: 'insp:summary', name: 'Summary' },
  { id: 'insp:fit', name: 'Fit checks' },
  { id: 'insp:poles', name: 'Support poles' },
  { id: 'insp:bracing', name: 'Bracing' },
  { id: 'insp:price', name: 'Price estimate' },
  { id: 'insp:selected', name: 'Selected part' },
  { id: 'insp:export', name: 'Export' },
  { id: 'insp:pipeline', name: 'Pipeline' },
] as const;

export const SIDE_TABS = ['candles', 'shelf', 'shelves', 'objects', 'materials', 'move', 'measure'];

export const groupPanel = (g: string) => `param:${g}`;
export const panelGroup = (id: string) => (id.startsWith('param:') ? id.slice(6) : null);

export const KNOWN: Known = {
  a: GROUPS.map(groupPanel),
  b: INSPECTOR_PANELS.map((p) => p.id),
  controls: PARAMS.filter((p) => !SWITCH_IDS.has(p.id)).map((p) => ({ id: p.id, home: groupPanel(p.group) })),
  accepts: (panel) => panel.startsWith('param:'),
  sideTabs: SIDE_TABS,
};
const HOME = new Map(KNOWN.controls.map((c) => [c.id, c.home]));
export const homeOf = (id: string) => HOME.get(id) ?? '';

export interface SavedLayout {
  id: string;
  name: string;
  panels: PanelLayout;
  /** The view workspace (which views are open, split or floating) when it was saved. */
  workspace?: Layout;
  sidebarWidth?: number;
}

const KEY = 'strata.panels.v1';

interface PanelStore {
  layout: PanelLayout;
  saved: SavedLayout[];
  /** The saved layout last loaded or saved, if any (changes after are still kept as you go). */
  current: string | null;
  /** Edit layout: grips on every control. Not kept across reloads. */
  editing: boolean;
  edit: (f: (l: PanelLayout) => PanelLayout) => void;
  setEditing: (on: boolean) => void;
  movePanel: (panel: string, side: Side, before: string | null) => void;
  nudgePanel: (panel: string, dir: -1 | 1) => void;
  moveControl: (id: string, panel: string, before: string | null) => void;
  nudgeControl: (id: string, dir: -1 | 1, shown?: (panel: string) => string[]) => void;
  sendHome: (id: string) => void;
  addPanel: (name: string, side?: Side) => string;
  renamePanel: (id: string, name: string) => void;
  removePanel: (id: string) => void;
  resetPanel: (id: string) => void;
  moveSideTab: (tab: string, before: string | null) => void;
  setWidth: (side: Side, w: number) => void;
  toggleHide: (side: Side) => void;
  toggleSwap: () => void;
  /** Save what's on screen now as a named layout (an existing name is overwritten). */
  saveAs: (name: string) => void;
  loadSaved: (id: string) => void;
  renameSaved: (id: string, name: string) => void;
  removeSaved: (id: string) => void;
  /** Everything back to how the app starts: panels, controls, columns, sidebar tabs and the view workspace. */
  resetAll: () => void;
  /** All saved layouts as a file. */
  exportText: () => string;
  /** Adds the layouts in a file (same names are replaced). Returns how many. */
  importText: (text: string) => number;
}

function cleanSaved(raw: unknown): SavedLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SavedLayout>;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  const workspace = r.workspace ? (normalise(r.workspace, ALL_TABS) ?? undefined) : undefined;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid('l'),
    name: r.name.trim().slice(0, 60),
    panels: normaliseLayout(r.panels, KNOWN),
    workspace,
    sidebarWidth: typeof r.sidebarWidth === 'number' && Number.isFinite(r.sidebarWidth) ? r.sidebarWidth : undefined,
  };
}

function load(): Pick<PanelStore, 'layout' | 'saved' | 'current'> {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (d && typeof d === 'object') {
      const saved = (Array.isArray(d.saved) ? d.saved : []).map(cleanSaved).filter(Boolean) as SavedLayout[];
      return { layout: normaliseLayout(d.layout, KNOWN), saved, current: saved.some((s) => s.id === d.current) ? d.current : null };
    }
  } catch {
    /* unreadable: start from the usual layout */
  }
  return { layout: defaultLayout(KNOWN), saved: [], current: null };
}

// The sidebar width lives in sidebarState; reached lazily so this store has no UI imports.
type SidebarBridge = { width: () => number; setWidth: (w: number) => void };
let sidebar: SidebarBridge = { width: () => 360, setWidth: () => {} };
export const connectSidebar = (b: SidebarBridge) => void (sidebar = b);

export const usePanels = create<PanelStore>((set, get) => {
  const edit = (f: (l: PanelLayout) => PanelLayout) => set((s) => ({ layout: f(s.layout) }));
  return {
    ...load(),
    editing: false,
    edit,
    setEditing: (on) => set({ editing: on }),
    movePanel: (p, side, before) => edit((l) => movePanel(l, p, side, before)),
    nudgePanel: (p, dir) => edit((l) => nudgePanel(l, p, dir)),
    moveControl: (id, p, before) => edit((l) => moveControl(l, id, p, before, KNOWN)),
    nudgeControl: (id, dir, shown) => edit((l) => nudgeControl(l, id, dir, KNOWN, shown)),
    sendHome: (id) => edit((l) => sendHome(l, id)),
    addPanel: (name, side = 'a') => {
      const r = addCustom(get().layout, name, side);
      set({ layout: r.layout });
      return r.id;
    },
    renamePanel: (id, name) => edit((l) => renameCustom(l, id, name)),
    removePanel: (id) => edit((l) => removeCustom(l, id)),
    resetPanel: (id) => edit((l) => resetPanel(l, id, KNOWN)),
    moveSideTab: (tab, before) => edit((l) => moveSideTab(l, tab, before)),
    setWidth: (side, w) => edit((l) => normaliseLayout({ ...l, widths: { ...l.widths, [side]: w } }, KNOWN)),
    toggleHide: (side) => edit((l) => ({ ...l, hide: { ...l.hide, [side]: !l.hide[side] } })),
    toggleSwap: () => edit((l) => ({ ...l, swap: !l.swap })),
    saveAs: (name) => {
      const n = name.trim().slice(0, 60);
      if (!n) return;
      const prev = get().saved.find((s) => s.name.toLowerCase() === n.toLowerCase());
      const entry: SavedLayout = {
        id: prev?.id ?? uid('l'),
        name: n,
        panels: structuredClone(get().layout),
        workspace: structuredClone(activeLayout(useWorkspaces.getState())),
        sidebarWidth: sidebar.width(),
      };
      set((s) => ({ saved: prev ? s.saved.map((x) => (x.id === prev.id ? entry : x)) : [...s.saved, entry], current: entry.id }));
    },
    loadSaved: (id) => {
      const s = get().saved.find((x) => x.id === id);
      if (!s) return;
      set({ layout: normaliseLayout(structuredClone(s.panels), KNOWN), current: id });
      if (s.workspace) {
        const w = structuredClone(s.workspace);
        useWorkspaces.getState().edit(() => w);
      }
      if (s.sidebarWidth) sidebar.setWidth(s.sidebarWidth);
    },
    renameSaved: (id, name) => {
      const n = name.trim().slice(0, 60);
      if (n) set((s) => ({ saved: s.saved.map((x) => (x.id === id ? { ...x, name: n } : x)) }));
    },
    removeSaved: (id) => set((s) => ({ saved: s.saved.filter((x) => x.id !== id), current: s.current === id ? null : s.current })),
    resetAll: () => {
      set({ layout: defaultLayout(KNOWN), current: null });
      useWorkspaces.getState().reset();
      sidebar.setWidth(360);
    },
    exportText: () => JSON.stringify({ kind: 'strata-layouts', v: 1, layouts: get().saved }, null, 2),
    importText: (text) => {
      const d = JSON.parse(text);
      const list = (Array.isArray(d?.layouts) ? d.layouts : Array.isArray(d) ? d : [d]).map(cleanSaved).filter(Boolean) as SavedLayout[];
      if (!list.length) throw new Error('No layouts in that file');
      set((s) => {
        const saved = [...s.saved];
        for (const l of list) {
          const i = saved.findIndex((x) => x.name.toLowerCase() === l.name.toLowerCase());
          if (i >= 0) saved[i] = { ...l, id: saved[i].id };
          else saved.push({ ...l, id: saved.some((x) => x.id === l.id) ? uid('l') : l.id });
        }
        return { saved };
      });
      return list.length;
    },
  };
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
usePanels.subscribe((s, prev) => {
  if (s.layout === prev.layout && s.saved === prev.saved && s.current === prev.current) return;
  // column-edge drags change the width every frame; write once they settle
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ layout: s.layout, saved: s.saved, current: s.current }));
    } catch {
      /* private mode: kept until the page closes */
    }
  }, 200);
});
