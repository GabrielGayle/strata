import { create } from 'zustand';
import { isLiteral } from '../core/expr';
import { PARAMS, PARAM_MAP, type RawValue } from '../core/params';
import { applyPreset, deserialize, newProject, type ImageAsset, type Preset, type Project, type Variant } from '../core/project';
import type { Composition, Surface } from '../core/compose';
import type { PourLayer } from '../core/mould';
import { isIdentity, type PartMove } from '../core/moves';
import { mulberry32 } from '../core/rng';
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from '../ui/theme';

export type Tab = '3d' | 'plates' | 'nest' | 'mould' | 'unfold' | 'image' | 'graph' | 'compare';
export type Snap = 'iso' | 'front' | 'side' | 'top';

export interface UiState {
  tab: Tab;
  selected: string | null; // part id
  ortho: boolean;
  snap: { dir: Snap; n: number; follow?: boolean };
  showMoulds: boolean;
  explode: boolean;
  xray: boolean;
  showIssues: boolean;
  showSource: boolean;
  collapsed: Record<string, boolean>;
  theme: ThemeChoice;
  filter: string;
  focusParam: string | null;
  reliefTilt: number;
  reliefTint: boolean;
  compareA: string; // variant id or 'current'
  compareB: string;
  toast: string | null;
  /** Hand placement of plates in the 3D view. */
  moveMode: boolean;
  gizmoMode: 'translate' | 'rotate';
  gizmoSpace: 'world' | 'local';
}

/** A whole master setup (project) open in its own tab. The active one lives in `project`. */
export interface SetupTab {
  id: string;
  /** Last state of an inactive tab; for the active tab, read `project` instead. */
  project: Project;
}

interface Store {
  project: Project;
  setups: SetupTab[];
  activeSetup: string;
  newSetup: (mode: 'duplicate' | 'blank') => void;
  switchSetup: (id: string) => void;
  closeSetup: (id: string) => void;
  past: Project[];
  future: Project[];
  ui: UiState;
  setParam: (id: string, value: RawValue) => void;
  setParams: (patch: Record<string, RawValue>, label?: string) => void;
  toggleLock: (id: string) => void;
  setPour: (pour: PourLayer[]) => void;
  /** Place one plate by hand (null puts it back where it was designed). */
  movePart: (key: string, move: PartMove | null) => void;
  resetMoves: () => void;
  setName: (name: string) => void;
  setAsset: (kind: 'image' | 'mesh', slot: string, asset: any) => void;
  replaceProject: (p: Project) => void;
  /** Store the composer's blocks and the rendered surface images in one undo step. */
  applyComposition: (comp: Composition, images: Partial<Record<Surface, ImageAsset | null>>, patch: Record<string, RawValue>) => void;
  undo: () => void;
  redo: () => void;
  randomise: () => void;
  shuffleGentle: () => void;
  /** `images` (e.g. a preset's sound picture) are set in the same undo step. */
  loadPreset: (p: Preset, images?: Project['images']) => void;
  saveVariant: (name: string) => void;
  loadVariant: (id: string) => void;
  deleteVariant: (id: string) => void;
  setUi: (patch: Partial<UiState>) => void;
  setTheme: (t: ThemeChoice) => void;
  toast: (msg: string) => void;
}

const STORAGE_KEY = 'strata.project.v1';
const UI_KEY = 'strata.ui.v1';
const SETUPS_KEY = 'strata.setups.v1';

function loadInitial(): Project {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) return deserialize(s);
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return newProject();
}

/** Tabs from last time. The active tab's project is the autosaved one, so it isn't stored twice. */
function loadSetups(active: Project): { setups: SetupTab[]; activeSetup: string } {
  try {
    const s = localStorage.getItem(SETUPS_KEY);
    if (s) {
      const raw = JSON.parse(s);
      const list: SetupTab[] = [];
      for (const t of raw.list ?? []) {
        if (t.id === raw.active) list.push({ id: t.id, project: active });
        else if (t.project) list.push({ id: t.id, project: deserialize(JSON.stringify(t.project)) });
      }
      if (list.some((t) => t.id === raw.active)) return { setups: list, activeSetup: raw.active };
    }
  } catch {
    /* corrupt: fall back to one tab */
  }
  return { setups: [{ id: 's1', project: active }], activeSetup: 's1' };
}

// undo history per setup tab, kept for the session only
const histories = new Map<string, { past: Project[]; future: Project[] }>();

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
  const initial = loadInitial();
  /** Park the active tab (project and history) and bring another one in. */
  const activate = (id: string, setups: SetupTab[]) => {
    const { project, past, future, activeSetup } = get();
    histories.set(activeSetup, { past, future });
    const parked = setups.map((t) => (t.id === activeSetup ? { ...t, project } : t));
    const next = parked.find((t) => t.id === id)!;
    const h = histories.get(id) ?? { past: [], future: [] };
    lastKey = '';
    set({ setups: parked, activeSetup: id, project: next.project, past: h.past, future: h.future });
  };
  return {
    project: initial,
    ...loadSetups(initial),
    past: [],
    future: [],
    newSetup: (mode) => {
      const { project, setups } = get();
      const id = `s${Date.now().toString(36)}`;
      const fresh = mode === 'duplicate' ? { ...project, name: `${project.name} copy` } : newProject();
      if (mode === 'blank') fresh.name = `Setup ${setups.length + 1}`;
      activate(id, [...setups, { id, project: fresh }]);
      get().toast(mode === 'duplicate' ? 'Duplicated this setup into a new tab' : 'Opened a blank setup');
    },
    switchSetup: (id) => {
      if (id === get().activeSetup || !get().setups.some((t) => t.id === id)) return;
      activate(id, get().setups);
    },
    closeSetup: (id) => {
      const { setups, activeSetup } = get();
      if (setups.length < 2) return;
      const i = setups.findIndex((t) => t.id === id);
      if (id === activeSetup) activate(setups[i + 1]?.id ?? setups[i - 1].id, setups);
      set({ setups: get().setups.filter((t) => t.id !== id) });
      histories.delete(id);
    },
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
      theme: loadTheme(),
      reliefTilt: 0,
      reliefTint: true,
      compareA: 'current',
      compareB: 'current',
      toast: null,
      moveMode: false,
      gizmoMode: 'translate',
      gizmoSpace: 'world',
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
    movePart: (key, move) => {
      const p = get().project;
      const moves = { ...p.moves };
      if (!move || isIdentity(move)) delete moves[key];
      else moves[key] = move;
      commit({ ...p, moves: Object.keys(moves).length ? moves : undefined }, `move:${key}:${performance.now()}`);
    },
    resetMoves: () => {
      const p = get().project;
      if (!p.moves) return;
      commit({ ...p, moves: undefined }, `moves:${performance.now()}`);
      get().toast('Every plate is back where it was designed');
    },
    setName: (name) => commit({ ...get().project, name }, 'name'),
    setAsset: (kind, slot, asset) => {
      const p = get().project;
      if (kind === 'image') commit({ ...p, images: { ...p.images, [slot]: asset ?? undefined } }, `img:${slot}:${performance.now()}`);
      else commit({ ...p, meshes: { ...p.meshes, [slot]: asset ?? undefined } }, `mesh:${slot}:${performance.now()}`);
    },
    replaceProject: (np) => commit(np, `replace:${performance.now()}`),
    applyComposition: (comp, imgs, patch) => {
      const p = get().project;
      const images = { ...p.images };
      for (const [k, a] of Object.entries(imgs) as [Surface, ImageAsset | null][]) images[k] = a ?? undefined;
      commit({ ...p, composition: comp, images, params: { ...p.params, ...patch } }, `compose:${performance.now()}`);
    },
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
    shuffleGentle: () => {
      // a curated range that lands on soft, flowing impressions: shallow, smooth,
      // low erosion with neighbours that follow each other, rounded edges
      const p = get().project;
      const rnd = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
      const r = (lo: number, hi: number, d = 2) => String(+(lo + (hi - lo) * rnd()).toFixed(d));
      const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
      const ranges: Record<string, () => RawValue> = {
        topDepth: () => r(5, 20, 1),
        topSteps: () => pick(['0', '0', '0', '2', '3']),
        topFloor: () => pick(['follow', 'follow', 'flat']),
        topThreshold: () => r(0.05, 0.3),
        topProfile: () => pick(['tone', 'pillow', 'pillow', 'balloon', 'balloon']),
        topBillow: () => r(8, 45, 0),
        cutSmooth: () => r(2, 10, 1),
        edgeRound: () => r(0.5, 4, 1),
        edgeFlow: () => r(6, 40, 0),
        imgSmooth: () => pick(['1', '2', '2', '3', '4']),
        imgContrast: () => r(0.75, 1.5),
        erosionAmp: () => r(2, 14, 1),
        erosionScale: () => r(150, 420, 0),
        octaves: () => pick(['2', '3', '3', '4']),
        roughness: () => r(0.3, 0.55),
        banding: () => r(0, 0.4),
        bandHeight: () => r(10, 30, 0),
        coherence: () => r(0.8, 0.97),
        crest: () => r(-10, 40, 0),
        slope: () => r(-20, 20, 0),
        seed: () => String(Math.floor(rnd() * 9999)),
      };
      const patch: Record<string, RawValue> = {};
      for (const [id, gen] of Object.entries(ranges)) {
        if (p.locks[id]) continue;
        const d = PARAM_MAP[id];
        const cur = String(p.params[id] ?? d.def);
        if (d.kind === 'number' && !isLiteral(cur)) continue; // linked values stay linked
        patch[id] = gen();
      }
      if (p.images.top && String(p.params.imgTopMode ?? 'off') === 'off') patch.imgTopMode = 'carve';
      commit({ ...p, params: { ...p.params, ...patch } }, `gentle:${performance.now()}`);
      get().toast(p.images.top ? 'Shuffled a gentle impression (undo to step back)' : 'Shuffled gentle strata. Load a top image to press it in.');
    },
    loadPreset: (preset, images) => {
      const p = get().project;
      commit(applyPreset(p, preset, images), `preset:${performance.now()}`);
      // re-frame the camera: presets range from 6 cm to 80 cm across
      const ui = get().ui;
      set({ ui: { ...ui, snap: { dir: ui.snap.dir, n: ui.snap.n + 1, follow: true } } });
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
        moves: p.moves,
        createdAt: new Date().toISOString(),
      };
      commit({ ...p, variants: [...p.variants, v] }, `variant:${v.id}`);
      get().toast(`Saved variant "${name}"`);
    },
    loadVariant: (id) => {
      const p = get().project;
      const v = p.variants.find((x) => x.id === id);
      if (!v) return;
      commit({ ...p, params: { ...p.params, ...v.params }, locks: { ...v.locks }, pour: v.pour.map((x) => ({ ...x })), moves: v.moves }, `loadvar:${performance.now()}`);
      get().toast(`Loaded variant "${v.name}"`);
    },
    deleteVariant: (id) => {
      const p = get().project;
      commit({ ...p, variants: p.variants.filter((x) => x.id !== id) }, `delvar:${performance.now()}`);
    },
    setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
    setTheme: (t) => {
      applyTheme(t);
      saveTheme(t);
      set({ ui: { ...get().ui, theme: t } });
    },
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
  if (s.setups !== prev.setups || s.activeSetup !== prev.activeSetup) {
    try {
      localStorage.setItem(SETUPS_KEY, JSON.stringify({ active: s.activeSetup, list: s.setups.map((t) => (t.id === s.activeSetup ? { id: t.id } : t)) }));
      // the active tab's project must match straight away, not after the autosave delay
      if (s.activeSetup !== prev.activeSetup) localStorage.setItem(STORAGE_KEY, JSON.stringify(s.project));
    } catch {
      s.toast('This browser is out of room to keep every setup tab; save the ones you need as project files.');
    }
  }
  if (s.ui.tab !== prev.ui.tab || s.ui.collapsed !== prev.ui.collapsed || s.ui.ortho !== prev.ui.ortho) {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ tab: s.ui.tab, collapsed: s.ui.collapsed, ortho: s.ui.ortho }));
    } catch {
      /* ignore */
    }
  }
});
