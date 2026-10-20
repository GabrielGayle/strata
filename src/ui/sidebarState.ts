// Which tab the 3D view's sidebar shows, and its width. The tabs ride on the
// store's mode flags (paintMode, moveMode, objectsMode, measureMode), so a tab
// is open exactly while its mode is on; the Candles / Shelf / Objects choice
// and the width are kept here and across reloads.
import { create } from 'zustand';
import { useStore, type UiState } from '../state/store';

export type ObjectsView = 'objects' | 'shelf' | 'shelves' | 'candles';
export type SideTab = ObjectsView | 'materials' | 'move' | 'measure';

const KEY = 'strata.sidebar.v1';
export const MIN_W = 240;
export const DEFAULT_W = 360;

interface Saved {
  width: number;
  /** The Candles / Shelf / Objects tab last open. */
  objects: ObjectsView;
  /** The tab N opens again. */
  last: SideTab;
}

function readSaved(): Saved {
  const base: Saved = { width: DEFAULT_W, objects: 'candles', last: 'candles' };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' ? { ...base, ...raw } : base;
  } catch {
    return base;
  }
}

export const useSidebar = create<Saved>(readSaved);

export function rememberSidebar(patch: Partial<Saved>) {
  useSidebar.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(useSidebar.getState()));
  } catch {
    /* private mode: just not remembered */
  }
}

/** The mode flags that open a tab. The modes stay one at a time, as before. */
const MODES = { paintMode: false, moveMode: false, objectsMode: false, measureMode: false };
function modesFor(tab: SideTab | null): Partial<UiState> {
  if (!tab) return MODES;
  if (tab === 'materials') return { ...MODES, paintMode: true };
  if (tab === 'move') return { ...MODES, moveMode: true };
  if (tab === 'measure') return { ...MODES, measureMode: true };
  return { ...MODES, objectsMode: true };
}

/** Which tab is open, if any. Measuring wins, as it did over the floating windows. */
export function useSideTab(): SideTab | null {
  const ui = useStore((s) => s.ui);
  const objects = useSidebar((s) => s.objects);
  if (ui.measureMode) return 'measure';
  if (ui.paintMode) return 'materials';
  if (ui.moveMode) return 'move';
  if (ui.objectsMode) return objects;
  return null;
}

/** Open a sidebar tab (and switch on its mode), or shut the sidebar with null. */
export function openSideTab(tab: SideTab | null) {
  if (tab) rememberSidebar(tab === 'candles' || tab === 'shelf' || tab === 'shelves' || tab === 'objects' ? { last: tab, objects: tab } : { last: tab });
  useStore.getState().setUi(modesFor(tab));
}

export const sidebarIsOpen = (ui: UiState) => ui.paintMode || ui.moveMode || ui.objectsMode || ui.measureMode;
