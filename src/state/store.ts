import { create } from 'zustand';
import { isLiteral } from '../core/expr';
import { PARAMS, PARAM_MAP, type RawValue } from '../core/params';
import { applyPreset, deserialize, newProject, type Preset, type Project, type Variant } from '../core/project';
import type { PourLayer } from '../core/mould';
import { mulberry32 } from '../core/rng';

export type Tab = '3d' | 'plates' | 'nest' | 'mould' | 'unfold' | 'image' | 'graph' | 'compare';
export type Snap = 'iso' | 'front' | 'side' | 'top';

export interface UiState {
  tab: Tab;
  selected: string | null; // part id
  ortho: boolean;
  snap: { dir: Snap; n: number };
  showMoulds: boolean;
  explode: boolean;
  xray: boolean;
  showIssues: boolean;
  showSource: boolean;
  collapsed: Record<string, boolean>;
  filter: string;
  focusParam: string | null;
  reliefTilt: number;
  reliefTint: boolean;
  compareA: string; // variant id or 'current'
  compareB: string;
  toast: string | null;
}

interface Store {
  project: Project;
  past: Project[];
  future: Project[];
  ui: UiState;
  setParam: (id: string, value: RawValue) => void;
  setParams: (patch: Record<string, RawValue>, label?: string) => void;
  toggleLock: (id: string) => void;
  setPour: (pour: PourLayer[]) => void;
  setName: (name: string) => void;
  setAsset: (kind: 'image' | 'mesh', slot: string, asset: any) => void;
  replaceProject: (p: Project) => void;
  undo: () => void;
  redo: () => void;
  randomise: () => void;
  loadPreset: (p: Preset) => void;
  saveVariant: (name: string) => void;
  loadVariant: (id: string) => void;
  deleteVariant: (id: string) => void;
  setUi: (patch: Partial<UiState>) => void;
  toast: (msg: string) => void;
}

const STORAGE_KEY = 'strata.project.v1';
const UI_KEY = 'strata.ui.v1';

function loadInitial(): Project {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) return deserialize(s);
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return newProject();
}

function loadUi(): Partial<UiState> {
  try {
    const s = localStorage.getItem(UI_KEY);
    if (s) {
      const u = JSON.parse(s);
      return { tab: u.tab, collapsed: u.collapsed ?? {}, ortho: !!u.ortho };
    }
  } catch {
    /* ignore */
  }
  return {};
}

let lastKey = '';
let lastTime = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<Store>((set, get) => {
  /** Apply a change; rapid edits to the same thing collapse into one undo step. */
  const commit = (next: Project, key: string) => {
    const now = performance.now();
    const { project, past } = get();
    const merge = key === lastKey && now - lastTime < 700 && past.length > 0;
    lastKey = key;
    lastTime = now;
    set({ project: next, past: merge ? past : [...past.slice(-199), project], future: [] });
  };
  return {
    project: loadInitial(),
    past: [],
    future: [],
    ui: {
      tab: '3d',
      selected: null,
      ortho: false,
      snap: { dir: 'iso', n: 0 },
      showMoulds: false,
      explode: true,
      xray: false,
      showIssues: true,
      showSource: true,
      collapsed: { 'Source form': true, Concrete: true, Mould: true, Unfold: true, Fabrication: true, Image: true },
      filter: '',
      focusParam: null,
      reliefTilt: 0,
      reliefTint: true,
      compareA: 'current',
      compareB: 'current',
      toast: null,
      ...loadUi(),
    },
    setParam: (id, value) => {
      const p = get().project;
      if (p.params[id] === value) return;
      commit({ ...p, params: { ...p.params, [id]: value } }, `param:${id}`);
    },
    setParams: (patch, label = 'params') => {
      const p = get().project;
      commit({ ...p, params: { ...p.params, ...patch } }, `${label}:${performance.now()}`);
    },
    toggleLock: (id) => {
      const p = get().project;
      commit({ ...p, locks: { ...p.locks, [id]: !p.locks[id] } }, `lock:${id}:${performance.now()}`);
    },
    setPour: (pour) => commit({ ...get().project, pour }, 'pour'),
    setName: (name) => commit({ ...get().project, name }, 'name'),
    setAsset: (kind, slot, asset) => {
      const p = get().project;
      if (kind === 'image') commit({ ...p, images: { ...p.images, [slot]: asset ?? undefined } }, `img:${slot}:${performance.now()}`);
      else commit({ ...p, meshes: { ...p.meshes, [slot]: asset ?? undefined } }, `mesh:${slot}:${performance.now()}`);
    },
    replaceProject: (np) => commit(np, `replace:${performance.now()}`),
    undo: () => {
      const { past, project, future } = get();
      if (!past.length) return;
      lastKey = '';
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
    },
    redo: () => {
      const { past, project, future } = get();
      if (!future.length) return;
      lastKey = '';
      set({ project: future[0], future: future.slice(1), past: [...past, project] });
    },
    randomise: () => {
      const p = get().project;
      const rnd = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
      const patch: Record<string, RawValue> = {};
      for (const d of PARAMS) {
        if (!d.rand || p.locks[d.id] || d.kind !== 'number') continue;
        const cur = String(p.params[d.id] ?? d.def);
        if (!isLiteral(cur)) continue; // expressions stay linked
        const lo = d.min ?? 0;
        const hi = d.max ?? 1;
        // stay within a sensible band around the current value rather than the full range
        const c = parseFloat(cur);
        const span = (hi - lo) * 0.25;
        let x = Math.min(hi, Math.max(lo, c + (rnd() * 2 - 1) * span));
        if (d.id === 'seed') x = Math.floor(rnd() * 9999);
        const step = d.step ?? 1;
        x = Math.round(x / step) * step;
        if (d.int) x = Math.round(x);
        patch[d.id] = String(+x.toFixed(4));
      }
      commit({ ...p, params: { ...p.params, ...patch } }, `rand:${performance.now()}`);
      get().toast(`Randomised ${Object.keys(patch).length} unlocked values`);
    },
    loadPreset: (preset) => {
      const p = get().project;
      commit(applyPreset(p, preset), `preset:${performance.now()}`);
      get().toast(`Preset: ${preset.name}`);
    },
    saveVariant: (name) => {
      const p = get().project;
      const v: Variant = {
        id: `v${Date.now().toString(36)}`,
        name,
        params: { ...p.params },
        locks: { ...p.locks },
        pour: p.pour.map((x) => ({ ...x })),
        createdAt: new Date().toISOString(),
      };
      commit({ ...p, variants: [...p.variants, v] }, `variant:${v.id}`);
      get().toast(`Saved variant "${name}"`);
    },
    loadVariant: (id) => {
      const p = get().project;
      const v = p.variants.find((x) => x.id === id);
      if (!v) return;
      commit({ ...p, params: { ...p.params, ...v.params }, locks: { ...v.locks }, pour: v.pour.map((x) => ({ ...x })) }, `loadvar:${performance.now()}`);
      get().toast(`Loaded variant "${v.name}"`);
    },
    deleteVariant: (id) => {
      const p = get().project;
      commit({ ...p, variants: p.variants.filter((x) => x.id !== id) }, `delvar:${performance.now()}`);
    },
    setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
    toast: (msg) => {
      clearTimeout(toastTimer);
      set({ ui: { ...get().ui, toast: msg } });
      toastTimer = setTimeout(() => set({ ui: { ...get().ui, toast: null } }), 2600);
    },
  };
});

// autosave (per-browser convenience; the JSON file is the real save)
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.project !== prev.project) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s.project));
      } catch {
        /* quota or disabled storage */
      }
    }, 500);
  }
  if (s.ui.tab !== prev.ui.tab || s.ui.collapsed !== prev.ui.collapsed || s.ui.ortho !== prev.ui.ortho) {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ tab: s.ui.tab, collapsed: s.ui.collapsed, ortho: s.ui.ortho }));
    } catch {
      /* ignore */
    }
  }
});

export const paramDef = (id: string) => PARAM_MAP[id];
