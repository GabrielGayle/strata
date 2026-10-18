export type ViewportLayerId =
  | 'concrete'
  | 'frame'
  | 'plates'
  | 'rods'
  | 'fin'
  | 'grid'
  | 'base'
  | 'engraving'
  | 'water'
  | 'labels'
  | 'objects';

export type ViewportLayers = Record<ViewportLayerId, boolean>;

export const VIEWPORT_LAYER_LABELS: Record<ViewportLayerId, string> = {
  concrete: 'Concrete',
  frame: 'Frame',
  plates: 'Plates',
  rods: 'Rods',
  fin: 'Fin',
  grid: 'Grid',
  base: 'Base',
  engraving: 'Engrave / OSM',
  water: 'Water',
  labels: 'Labels / dims',
  objects: 'Objects',
};

export const DEFAULT_VIEWPORT_LAYERS: ViewportLayers = {
  concrete: true,
  frame: true,
  plates: true,
  rods: true,
  fin: true,
  grid: true,
  base: true,
  engraving: true,
  water: true,
  labels: true,
  objects: true,
};

/** Rods button: Stamped/flat always, or whenever any rods exist (keeps the default 9-button toolbar). */
export function showRodsLayerToggle(
  sliceMode: string | undefined,
  sliced?: { brace?: { rods?: { rods?: { length: number } } | null } | null; stackRods?: { rods?: { length: number } } | null } | null,
): boolean {
  if (sliceMode === 'flat') return true;
  if ((sliced?.brace?.rods?.rods?.length ?? 0) > 0) return true;
  if ((sliced?.stackRods?.rods?.length ?? 0) > 0) return true;
  return false;
}

const KEY = 'strata.viewport.layers.v1';

/**
 * The concrete base. It once had two buttons (Base and Concrete) that each drew it
 * while the other was on, so neither hid it; now Base alone decides, and a stored
 * Concrete off still counts so a base hidden that way stays hidden.
 */
export function showBaseMesh(layers: ViewportLayers): boolean {
  return layers.base && layers.concrete !== false;
}

/** A placed object (postcard, box, candle…) in the 3D view: the Objects layer and its own eye. View only. */
export function showObject(layers: ViewportLayers, hidden: readonly string[] | undefined, id: string): boolean {
  return layers.objects !== false && !hidden?.includes(id);
}

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
