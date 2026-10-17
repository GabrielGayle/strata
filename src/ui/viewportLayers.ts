export type ViewportLayerId =
  | 'concrete'
  | 'frame'
  | 'plates'
  | 'fin'
  | 'grid'
  | 'base'
  | 'engraving'
  | 'water'
  | 'labels';

export type ViewportLayers = Record<ViewportLayerId, boolean>;

export const VIEWPORT_LAYER_LABELS: Record<ViewportLayerId, string> = {
  concrete: 'Concrete',
  frame: 'Frame',
  plates: 'Plates',
  fin: 'Fin',
  grid: 'Grid',
  base: 'Base',
  engraving: 'Engrave / OSM',
  water: 'Water',
  labels: 'Labels / dims',
};

export const DEFAULT_VIEWPORT_LAYERS: ViewportLayers = {
  concrete: true,
  frame: true,
  plates: true,
  fin: true,
  grid: true,
  base: true,
  engraving: true,
  water: true,
  labels: true,
};

const KEY = 'strata.viewport.layers.v1';

/** Insert mesh (Vermilion fin) is its own object — not gated by Plates. */
export function showInsertMesh(layers: ViewportLayers): boolean {
  return layers.fin;
}

export function loadViewportLayers(): ViewportLayers {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_VIEWPORT_LAYERS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_VIEWPORT_LAYERS };
    for (const id of Object.keys(DEFAULT_VIEWPORT_LAYERS) as ViewportLayerId[]) {
      if (typeof parsed[id] === 'boolean') out[id] = parsed[id];
    }
    if (typeof parsed.fin !== 'boolean' && typeof parsed.backing === 'boolean') out.fin = parsed.backing;
    return out;
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
