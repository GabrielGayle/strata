import { create } from 'zustand';
import { isLiteral } from '../core/expr';
import { PARAMS, PARAM_MAP, type RawValue } from '../core/params';
import { applyPreset, applyVariant, deserialize, newProject, type ImageAsset, type Preset, type Project, type Variant } from '../core/project';
import type { EarthView, EarthWorldPose } from '../core/earthView';
import type { MapSpec } from '../core/mapSpec';
import type { Composition, Surface } from '../core/compose';
import type { PourLayer } from '../core/mould';
import { isIdentity, type PartMove } from '../core/moves';
import { mulberry32 } from '../core/rng';
import { keepPlatesInPlace } from '../core/remap';
import type { Appearance } from '../core/appearance';
import type { DepthSettingKey, DepthSettings } from '../core/depth';
import { markDepthSettingOverrides, mergeDepthAfterRebuild, resetDepthSettingsToAuto } from '../core/depthOverrides';
import { markUserParamOverrides } from '../core/projectOverrides';
import type { ShadowSpec } from '../core/shadow';
import type { CutObject } from '../core/objects';
import type { ShelfSpec } from '../core/shelf';
import type { CandleSpec } from '../core/candles';
import type { WorldOrigin } from '../core/origin';
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from '../ui/theme';
import { loadViewportLayers, saveViewportLayers, type ViewportLayerId, type ViewportLayers } from '../ui/viewportLayers';
import { loadViewAids, saveViewAids, type ViewAids } from '../ui/viewAids';
import { createSaver, defaultKV, readWithLegacy, requestPersistentStorage, type KV, type SaveStatus } from './persist';
import { applyProjectPatch, type ProjectPatch } from '../core/design';
import { applyBuiltMapAsset, projectWithTopMapSpec } from '../core/mapTopAsset';
import { mapBuildKey } from '../core/mapBuildKey';
import { applyQuickMapToProject } from '../core/quickMap';
import { wordsParamPatch } from '../core/chantWords';
import { speechParamPatch } from '../core/speechTuning';

export type Tab = '3d' | 'plates' | 'nest' | 'mould' | 'unfold' | 'image' | 'map' | 'shadow' | 'graph' | 'nodes' | 'compare';

export interface MapTerrainUi {
  phase: 'idle' | 'working' | 'ready' | 'error';
  message: string;
  error?: string;
}
/** `shelf` looks from the postcard shelf's Unobstructed view angle. */
export type Snap = 'iso' | 'front' | 'side' | 'top' | 'shelf';

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
  /** Left column: parameters or the saves browser. */
  leftPane: 'params' | 'saves';
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
  /** Material picking in the 3D view: clicks put plates in the active bucket. */
  paintMode: boolean;
  activeBucket: string;
  /** Measuring tape in the 3D view (the measurements themselves live in ui/Measure, view-only). */
  measureMode: boolean;
  /** Placed objects panel in the 3D view, and which object it is editing. */
  objectsMode: boolean;
  objectSel: string | null;
  /** Placed objects hidden one by one in the 3D view (view only: they still cut and export). */
  hiddenObjects: string[];
  /** Postcard shelf: Unobstructed view (dev) section is expanded. */
  shelfViewDevOpen: boolean;
  /** What the node view is pointing at, lit up in the 3D view (origin, cards, objects, plates). */
  highlight: string | null;
  /** Sun study: clock time of day in hours, and whether the day is playing. Not part of the undo history. */
  sunTime: number;
  sunPlaying: boolean;
  viewportLayers: ViewportLayers;
  /** Edge outlines, plate tint and spread in the 3D view (view only). */
  viewAids: ViewAids;
  /** Apply a View-from-point pose in the 3D camera (n increments to retrigger). */
  pointView?: { n: number; pose: EarthWorldPose };
  /** Vertical FOV from the last point view; Iso/Front/… clear it. */
  pointViewFov?: number;
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
  /** Whether the browser autosave has caught up with the latest change. */
  saveStatus: SaveStatus;
  mapTerrain: MapTerrainUi;
  /** Bumped on Quick map / Apply bbox so a failed build can be retried (clears the hook skip). */
  mapRebuildEpoch: number;
  setMapTerrain: (patch: Partial<MapTerrainUi>) => void;
  finishMapTerrainBuild: (asset: ImageAsset) => void;
  ui: UiState;
  setParam: (id: string, value: RawValue) => void;
  setParams: (patch: Record<string, RawValue>, label?: string) => void;
  applyDesignPatch: (patch: ProjectPatch, label?: string) => void;
  toggleLock: (id: string) => void;
  setPour: (pour: PourLayer[]) => void;
  /** Shadow pictures and their times; `key` merges rapid edits (a time being typed) into one undo step. */
  setShadow: (shadow: ShadowSpec | undefined, key?: string) => void;
  /** Place one plate by hand (null puts it back where it was designed). */
  movePart: (key: string, move: PartMove | null) => void;
  resetMoves: () => void;
  /** Material buckets and which plates are in them. */
  setAppearance: (a: Appearance | undefined, label?: string) => void;
  /** Objects placed among the plates; `key` merges rapid edits (a value being dragged) into one undo step. */
  setObjects: (objects: CutObject[], key?: string) => void;
  /** The postcard shelf (undefined removes it). */
  setShelf: (shelf: ShelfSpec | undefined, key?: string) => void;
  /** The candelabra (undefined removes it). */
  setCandles: (candles: CandleSpec | undefined, key?: string) => void;
  setOrigin: (origin: WorldOrigin | undefined, key?: string) => void;
  /** Persist the 3D View-from-point camera with the project (local + cloud saves). */
  setSavedView: (view: EarthView | undefined) => void;
  setName: (name: string) => void;
  setAsset: (kind: 'image' | 'mesh', slot: string, asset: any) => void;
  /** Attach or update MapSpec on the top face (map window / design parser). */
  setTopMap: (map: MapSpec) => void;
  /** Dense plates, OSM engrave, no insert — one undo step; user overrides win. */
  applyQuickMap: () => void;
  /** Change how a depth image is shaped; slider drags merge into one undo step. `dataUrl` refreshes its picture. */
  setDepthSettings: (slot: 'top' | 'front' | 'side', patch: Partial<DepthSettings>, dataUrl?: string) => void;
  /** Clear per-field depth overrides and restore auto near/far (and related auto fields). */
  resetDepthToAuto: (slot: 'top' | 'front' | 'side', keys?: DepthSettingKey[]) => void;
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
  toggleViewportLayer: (id: ViewportLayerId) => void;
  setViewAids: (patch: Partial<ViewAids>) => void;
  setTheme: (t: ThemeChoice) => void;
  toast: (msg: string) => void;
}

const STORAGE_KEY = 'strata.project.v1';
const UI_KEY = 'strata.ui.v1';
const SETUPS_KEY = 'strata.setups.v1';
const RESCUE_KEY = 'strata.project.unreadable';

function parseProject(s: string | undefined): Project | null {
  if (!s) return null;
  try {
    return deserialize(s);
  } catch {
    return null; // corrupt: start fresh
  }
}

/** Tabs from last time. The active tab's project is the autosaved one, so it isn't stored twice. */
function parseSetups(s: string | undefined, active: Project): { setups: SetupTab[]; activeSetup: string } {
  try {
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
      return { tab: u.tab, collapsed: u.collapsed ?? {}, ortho: !!u.ortho, leftPane: u.leftPane === 'saves' ? 'saves' : 'params' };
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
  /** Commit a settings change, carrying hand moves and material picks to the plates where they were made. */
  const commitParams = (next: Project, key: string) => {
    const r = keepPlatesInPlace(get().project, next);
    commit(r.project, key);
    if (r.message) get().toast(r.message);
  };
  const initial = newProject();
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
    setups: [{ id: 's1', project: initial }],
    activeSetup: 's1',
    past: [],
    future: [],
    saveStatus: 'saved',
    mapTerrain: { phase: 'idle', message: '' },
    mapRebuildEpoch: 0,
    setMapTerrain: (patch) => set({ mapTerrain: { ...get().mapTerrain, ...patch } }),
    finishMapTerrainBuild: (asset) => {
      const p = get().project;
      const prev = p.images.top;
      if (!prev?.map) return;
      let top = asset;
      if (prev.depth && asset.depth) {
        top = { ...asset, depth: mergeDepthAfterRebuild(prev.depth, asset.depth) };
      }
      const next = applyBuiltMapAsset(p, top);
      if (!next) return;
      // Depth is derived from the current MapSpec — not a second undo step.
      // Quick map (and Maps presets) then restore in one Undo.
      set({ project: next, mapTerrain: { phase: 'ready', message: 'Map terrain ready', error: undefined } });
    },
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
      leftPane: 'params',
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
      paintMode: false,
      activeBucket: 'b1',
      measureMode: false,
      objectsMode: false,
      objectSel: null,
      hiddenObjects: [],
      shelfViewDevOpen: false,
      highlight: null,
      sunTime: 12,
      sunPlaying: false,
      viewportLayers: loadViewportLayers(),
      viewAids: loadViewAids(),
      ...loadUi(),
    },
    setParam: (id, value) => {
      const p = get().project;
      if (p.params[id] === value) return;
      const userParamOverrides = markUserParamOverrides(p.userParamOverrides, [id]);
      const params = { ...p.params, [id]: value };
      if (
        id === 'tuneWords' ||
        id === 'tuneMelodyRoot' ||
        id === 'tuneSpeechPlates' ||
        id === 'tuneSpeechFundamental' ||
        (id === 'tuneMode' && (value === 'words' || value === 'speech'))
      ) {
        if (String(params.tuneMode) === 'words') Object.assign(params, wordsParamPatch(String(params.tuneWords ?? ''), String(params.tuneMelodyRoot ?? 'G4')));
        if (String(params.tuneMode) === 'speech') {
          Object.assign(
            params,
            speechParamPatch(
              String(params.tuneWords ?? ''),
              String(params.tuneMelodyRoot ?? 'G4'),
              String(params.tuneSpeechPlates ?? '2'),
              params.tuneSpeechFundamental !== false && params.tuneSpeechFundamental !== 'false',
            ),
          );
        }
      }
      commitParams({ ...p, params, userParamOverrides }, `param:${id}`);
    },
    setParams: (patch, label = 'params') => {
      const p = get().project;
      const userParamOverrides = markUserParamOverrides(p.userParamOverrides, Object.keys(patch));
      commitParams({ ...p, params: { ...p.params, ...patch }, userParamOverrides }, `${label}:${performance.now()}`);
    },
    applyDesignPatch: (patch, label = 'design') => {
      const p = get().project;
      commit(applyProjectPatch(p, patch), `${label}:${performance.now()}`);
    },
    toggleLock: (id) => {
      const p = get().project;
      commit({ ...p, locks: { ...p.locks, [id]: !p.locks[id] } }, `lock:${id}:${performance.now()}`);
    },
    setPour: (pour) => commit({ ...get().project, pour }, 'pour'),
    setShadow: (shadow, key = 'shadow') => commit({ ...get().project, shadow: shadow?.frames.length ? shadow : undefined }, key),
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
    setAppearance: (a, label = 'appearance') => {
      const p = get().project;
      commit({ ...p, appearance: a }, `${label}:${performance.now()}`);
    },
    setObjects: (objects, key = `objects:${performance.now()}`) => commit({ ...get().project, objects: objects.length ? objects : undefined }, key),
    setShelf: (shelf, key = `shelf:${performance.now()}`) => commit({ ...get().project, shelf }, key),
    setCandles: (candles, key = `candles:${performance.now()}`) => commit({ ...get().project, candles }, key),
    setOrigin: (origin, key = `origin:${performance.now()}`) => commit({ ...get().project, origin }, key),
    setSavedView: (view) => commit({ ...get().project, savedView: view }, `saved-view:${performance.now()}`),
    setName: (name) => commit({ ...get().project, name }, 'name'),
    setAsset: (kind, slot, asset) => {
      const p = get().project;
      if (kind === 'image') commit({ ...p, images: { ...p.images, [slot]: asset ?? undefined } }, `img:${slot}:${performance.now()}`);
      else commit({ ...p, meshes: { ...p.meshes, [slot]: asset ?? undefined } }, `mesh:${slot}:${performance.now()}`);
    },
    setTopMap: (map) => {
      const p = get().project;
      const next = projectWithTopMapSpec(p, map);
      commit(next, `map:${performance.now()}`);
      set({
        mapTerrain: { phase: 'working', message: 'Queued terrain build…' },
        mapRebuildEpoch: (get().mapRebuildEpoch ?? 0) + 1,
      });
    },
    applyQuickMap: () => {
      const p = get().project;
      const next = applyQuickMapToProject(p);
      const prevKey = p.images.top?.map ? mapBuildKey(p.images.top.map) : '';
      const nextKey = next.images.top?.map ? mapBuildKey(next.images.top.map) : '';
      const retryError = get().mapTerrain.phase === 'error';
      commitParams(next, `quick-map:${performance.now()}`);
      if (next.images.top?.map && (nextKey !== prevKey || !next.images.top.map.buildKey || retryError)) {
        set({
          mapTerrain: { phase: 'working', message: 'Queued terrain build…' },
          mapRebuildEpoch: (get().mapRebuildEpoch ?? 0) + 1,
        });
      }
      const layers = {
        ...get().ui.viewportLayers,
        labels: true,
        engraving: true,
        water: true,
        fin: false,
      };
      saveViewportLayers(layers);
      set({ ui: { ...get().ui, viewportLayers: layers } });
      get().toast('Quick map: dense plates, OSM engrave, insert off');
    },
    setDepthSettings: (slot, patch, dataUrl) => {
      const p = get().project;
      const a = p.images[slot];
      if (!a?.depth) return;
      const hasPatch = Object.keys(patch).length > 0;
      const settingsOverrides = hasPatch ? markDepthSettingOverrides(a.depth.settingsOverrides, patch) : a.depth.settingsOverrides;
      const depth = hasPatch ? { ...a.depth, settings: { ...a.depth.settings, ...patch }, settingsOverrides } : a.depth;
      commit({ ...p, images: { ...p.images, [slot]: { ...a, depth, ...(dataUrl ? { dataUrl } : {}) } } }, `depth:${slot}`);
    },
    resetDepthToAuto: (slot, keys) => {
      const p = get().project;
      const a = p.images[slot];
      if (!a?.depth) return;
      const depth = resetDepthSettingsToAuto(a.depth, keys);
      commit({ ...p, images: { ...p.images, [slot]: { ...a, depth } } }, `depth-auto:${slot}`);
    },
    replaceProject: (np) => commit(np, `replace:${performance.now()}`),
    applyComposition: (comp, imgs, patch) => {
      const p = get().project;
      const images = { ...p.images };
      for (const [k, a] of Object.entries(imgs) as [Surface, ImageAsset | null][]) images[k] = a ?? undefined;
      commitParams({ ...p, composition: comp, images, params: { ...p.params, ...patch } }, `compose:${performance.now()}`);
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
      commitParams({ ...p, params: { ...p.params, ...patch } }, `rand:${performance.now()}`);
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
        topPuff: () => r(0.5, 2, 2),
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
      commitParams({ ...p, params: { ...p.params, ...patch } }, `gentle:${performance.now()}`);
      get().toast(p.images.top ? 'Shuffled a gentle impression (undo to step back)' : 'Shuffled gentle strata. Load a top image to press it in.');
    },
    loadPreset: (preset, images) => {
      const p = get().project;
      commitParams(applyPreset(p, preset, images), `preset:${performance.now()}`);
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
        appearance: p.appearance,
        images: { ...p.images },
        composition: p.composition,
        shadow: p.shadow ?? null,
        objects: p.objects ?? null,
        shelf: p.shelf ?? null,
        candles: p.candles ?? null,
        origin: p.origin ?? null,
        createdAt: new Date().toISOString(),
      };
      commit({ ...p, variants: [...p.variants, v] }, `variant:${v.id}`);
      get().toast(`Saved variant "${name}"`);
    },
    loadVariant: (id) => {
      const p = get().project;
      const v = p.variants.find((x) => x.id === id);
      if (!v) return;
      commit(applyVariant(p, v), `loadvar:${performance.now()}`);
      get().toast(`Loaded variant "${v.name}"`);
    },
    deleteVariant: (id) => {
      const p = get().project;
      commit({ ...p, variants: p.variants.filter((x) => x.id !== id) }, `delvar:${performance.now()}`);
    },
    setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
    toggleViewportLayer: (id) => {
      const cur = get().ui.viewportLayers;
      const layers = { ...cur, [id]: !cur[id] };
      // Base also clears an old Concrete-off, which no longer has a button of its own
      if (id === 'base') layers.concrete = layers.base;
      saveViewportLayers(layers);
      set({ ui: { ...get().ui, viewportLayers: layers } });
    },
    setViewAids: (patch) => {
      const aids = { ...get().ui.viewAids, ...patch };
      saveViewAids(aids);
      set({ ui: { ...get().ui, viewAids: aids } });
    },
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

// Autosave (per-browser convenience; the JSON file is the real save). Nothing
// is written until hydrate() has read the last session back, so a slow read
// can't overwrite it with the blank starting project.
let kv: KV = defaultKV();
let hydrated = false;
let warned = false;
const saver = createSaver(
  { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) },
  (status, err) => {
    useStore.setState({ saveStatus: status });
    if (status === 'failed' && !warned) {
      warned = true;
      console.warn('Strata autosave failed', err);
      useStore.getState().toast('This browser could not keep the latest changes. Save the project file (Save) to be safe.');
    }
    if (status === 'saved') warned = false;
  },
);

const setupsJson = (s: Store) => JSON.stringify({ active: s.activeSetup, list: s.setups.map((t) => (t.id === s.activeSetup ? { id: t.id } : t)) });

/** Read the last session back from browser storage. Call once before the app renders. */
export async function hydrate(store: KV = kv): Promise<void> {
  kv = store;
  const legacy = typeof localStorage !== 'undefined' ? localStorage : undefined;
  const text = await readWithLegacy(kv, STORAGE_KEY, legacy);
  const project = parseProject(text);
  // an autosave this version can't read is kept aside, not overwritten by the next edit
  if (text && !project) await kv.set(RESCUE_KEY, text).catch(() => undefined);
  if (project) {
    const { setups, activeSetup } = parseSetups(await readWithLegacy(kv, SETUPS_KEY, legacy), project);
    useStore.setState({ project, setups, activeSetup, past: [], future: [] });
  }
  hydrated = true;
  void requestPersistentStorage();
}

/** Wait for every queued autosave write (tests, and before a reload). */
export const flushSaves = () => saver.flush();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (hydrated && s.project !== prev.project) {
    clearTimeout(saveTimer);
    if (s.saveStatus === 'saved') useStore.setState({ saveStatus: 'saving' });
    saveTimer = setTimeout(() => void saver.save(STORAGE_KEY, JSON.stringify(useStore.getState().project)), 500);
  }
  if (hydrated && (s.setups !== prev.setups || s.activeSetup !== prev.activeSetup)) {
    void saver.save(SETUPS_KEY, setupsJson(s));
    // the active tab's project must match straight away, not after the autosave delay
    if (s.activeSetup !== prev.activeSetup) {
      clearTimeout(saveTimer);
      void saver.save(STORAGE_KEY, JSON.stringify(s.project));
    }
  }
  if (s.ui.tab !== prev.ui.tab || s.ui.collapsed !== prev.ui.collapsed || s.ui.ortho !== prev.ui.ortho || s.ui.leftPane !== prev.ui.leftPane) {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ tab: s.ui.tab, collapsed: s.ui.collapsed, ortho: s.ui.ortho, leftPane: s.ui.leftPane }));
    } catch {
      /* ignore */
    }
  }
});
