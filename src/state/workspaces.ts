// Saved workspaces: named arrangements of the view tabs (which panes, side by
// side or stacked, and any floating ones). Kept per browser, separate from
// projects and master setups, since they are about the screen, not the design.
import { create } from 'zustand';
import { dockFloat, moveTab, normalise, pane, raiseFloat, revealTab, setFloatRect, setRatio, split, uid, type DropTarget, type Float, type Layout, type Workspace } from '../core/workspace';
import type { Tab } from './store';

export const TABS: { id: Tab; label: string }[] = [
  { id: '3d', label: '3D' },
  { id: 'plates', label: 'Plates' },
  { id: 'nest', label: 'Nest' },
  { id: 'mould', label: 'Mould + pour' },
  { id: 'unfold', label: 'Unfold' },
  { id: 'image', label: 'Image / Graphic' },
  { id: 'graph', label: 'Graph' },
  { id: 'compare', label: 'Compare' },
];
export const ALL_TABS: Tab[] = TABS.map((t) => t.id);

const KEY = 'strata.workspaces.v1';

export const PRESETS: { id: string; name: string; hint: string; make: () => Layout }[] = [
  { id: 'tabs', name: 'Tabs', hint: 'one view at a time', make: () => ({ root: pane([...ALL_TABS]), floats: [] }) },
  {
    id: 'image-3d',
    name: 'Image + 3D',
    hint: 'image editing beside the 3D view',
    make: () => ({ root: split('row', pane(['image', 'graph']), pane(['3d', 'plates', 'nest', 'mould', 'unfold', 'compare']), 0.5), floats: [] }),
  },
  {
    id: 'plates-3d',
    name: 'Plates + 3D',
    hint: '3D with the plate list and nest beside it',
    make: () => ({ root: split('row', pane(['3d', 'image', 'graph', 'compare']), split('col', pane(['plates', 'unfold']), pane(['nest', 'mould']), 0.55), 0.55), floats: [] }),
  },
  {
    id: 'fabrication',
    name: 'Fabrication',
    hint: 'nest, mould and unfold together',
    make: () => ({ root: split('row', pane(['nest', 'plates', '3d', 'image', 'graph', 'compare']), split('col', pane(['mould']), pane(['unfold']), 0.5), 0.55), floats: [] }),
  },
];

const fromPreset = (id: string): Workspace => {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
  return { id: p.id, name: p.name, preset: p.id, layout: p.make() };
};

interface WorkspaceStore {
  list: Workspace[];
  active: string;
  /** Change the active workspace's layout. */
  edit: (f: (l: Layout) => Layout) => void;
  switchTo: (id: string) => void;
  /** Copy the active workspace under a new name and switch to it. */
  saveAs: (name: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  /** Put the active workspace back to how its starting layout looked. */
  reset: () => void;
  /** Bring back any starting workspace that was deleted. */
  restorePresets: () => void;
  // conveniences over `edit`
  move: (tab: string, to: DropTarget) => void;
  reveal: (tab: string) => void;
  dock: (floatId: string) => void;
  setFloat: (floatId: string, r: Partial<Pick<Float, 'x' | 'y' | 'w' | 'h'>>) => void;
  raise: (floatId: string) => void;
  resize: (splitId: string, ratio: number) => void;
}

function load(): { list: Workspace[]; active: string } {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const d = JSON.parse(s);
      const list: Workspace[] = (Array.isArray(d.list) ? d.list : [])
        .map((w: any) => {
          const layout = normalise(w?.layout, ALL_TABS);
          return layout && typeof w.id === 'string' ? { id: w.id, name: String(w.name || 'Workspace'), preset: typeof w.preset === 'string' ? w.preset : undefined, layout } : null;
        })
        .filter(Boolean);
      if (list.length) return { list, active: list.some((w) => w.id === d.active) ? d.active : list[0].id };
    }
  } catch {
    /* ignore */
  }
  const list = PRESETS.map((p) => fromPreset(p.id));
  return { list, active: list[0].id };
}

export const useWorkspaces = create<WorkspaceStore>((set, get) => {
  const edit = (f: (l: Layout) => Layout) =>
    set((s) => ({
      list: s.list.map((w) => {
        if (w.id !== s.active) return w;
        const layout = f(w.layout);
        return layout === w.layout ? w : { ...w, layout };
      }),
    }));
  return {
    ...load(),
    edit,
    switchTo: (id) => get().list.some((w) => w.id === id) && set({ active: id }),
    saveAs: (name) => {
      const cur = get().list.find((w) => w.id === get().active)!;
      const w: Workspace = { id: uid('w'), name: name.trim() || 'Workspace', layout: structuredClone(cur.layout) };
      set((s) => ({ list: [...s.list, w], active: w.id }));
    },
    rename: (id, name) => set((s) => ({ list: s.list.map((w) => (w.id === id ? { ...w, name: name.trim() || w.name } : w)) })),
    remove: (id) =>
      set((s) => {
        if (s.list.length < 2) return s;
        const i = s.list.findIndex((w) => w.id === id);
        const list = s.list.filter((w) => w.id !== id);
        return { list, active: s.active === id ? list[Math.max(0, i - 1)].id : s.active };
      }),
    reset: () => {
      const cur = get().list.find((w) => w.id === get().active)!;
      edit(() => fromPreset(cur.preset ?? 'tabs').layout);
    },
    restorePresets: () =>
      set((s) => ({ list: [...s.list, ...PRESETS.filter((p) => !s.list.some((w) => w.id === p.id)).map((p) => fromPreset(p.id))] })),
    move: (tab, to) => edit((l) => moveTab(l, tab, to)),
    reveal: (tab) => edit((l) => revealTab(l, tab)),
    dock: (id) => edit((l) => dockFloat(l, id)),
    setFloat: (id, r) => edit((l) => setFloatRect(l, id, r)),
    raise: (id) => edit((l) => raiseFloat(l, id)),
    resize: (id, r) => edit((l) => setRatio(l, id, r)),
  };
});

export const activeLayout = (s: WorkspaceStore) => s.list.find((w) => w.id === s.active)!.layout;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useWorkspaces.subscribe((s, prev) => {
  if (s.list === prev.list && s.active === prev.active) return;
  // divider drags change the layout every frame; write once they settle
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ active: s.active, list: s.list }));
    } catch {
      /* ignore */
    }
  }, 200);
});
