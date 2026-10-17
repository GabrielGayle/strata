export type ViewportLayerId =
  | 'concrete'
  | 'frame'
  | 'plates'
  | 'grid'
  | 'base'
  | 'backing'
  | 'engraving'
  | 'water'
  | 'labels';

export type ViewportLayers = Record<ViewportLayerId, boolean>;

export const VIEWPORT_LAYER_LABELS: Record<ViewportLayerId, string> = {
  concrete: 'Concrete',
  frame: 'Frame',
  plates: 'Plates',
  grid: 'Grid',
  base: 'Base',
  backing: 'Backing',
  engraving: 'Engrave / OSM',
  water: 'Water',
  labels: 'Labels / dims',
};

export const DEFAULT_VIEWPORT_LAYERS: ViewportLayers = {
  concrete: true,
  frame: true,
  plates: true,
  grid: true,
  base: true,
  backing: true,
  engraving: true,
  water: true,
  labels: true,
};

const KEY = 'strata.viewport.layers.v1';

export function loadViewportLayers(): ViewportLayers {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_VIEWPORT_LAYERS };
    const parsed = JSON.parse(raw) as Partial<ViewportLayers>;
    return { ...DEFAULT_VIEWPORT_LAYERS, ...parsed };
  } catch {
    return { ...DEFAULT_VIEWPORT_LAYERS };
  }
}

export function saveViewportLayers(layers: ViewportLayers): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(layers));
  } catch {
    /* private mode */
  }
}
