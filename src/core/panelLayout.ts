// Where the panels and controls sit on screen: which side column holds each
// panel and in what order, controls moved out of their own panel or put in a
// new order, panels the person made, column widths, and the 3D sidebar's tab
// order. Kept per browser, never in a project. Everything here is pure: the
// store (src/state/panelLayout.ts) saves it, the side columns read it.
//
// Nothing can be lost: `normaliseLayout` drops what it doesn't know and puts
// every known panel or control that has no place back where it starts.

export type Side = 'a' | 'b';

export interface CustomPanel {
  id: string;
  name: string;
}

export interface PanelLayout {
  v: 1;
  /** Panel ids top to bottom: `a` is the Parameters column, `b` the Inspector column. */
  a: string[];
  b: string[];
  /** Controls (parameter ids) moved out of their own panel: param id -> panel id. */
  moved: Record<string, string>;
  /** Hand-set order of the controls in a panel. Controls not listed follow, in their usual order. */
  order: Record<string, string[]>;
  /** Panels the person made, e.g. "My favourites". Their ids start `custom:`. */
  custom: CustomPanel[];
  /** Column widths in px. */
  widths: { a: number; b: number };
  hide: { a: boolean; b: boolean };
  /** Inspector column on the left, Parameters on the right. */
  swap: boolean;
  /** 3D view sidebar tabs, top to bottom. */
  sideTabs: string[];
}

/** What exists in the app right now: the panels each column starts with, every movable control and its own panel, the sidebar tabs. */
export interface Known {
  a: string[];
  b: string[];
  /** Movable controls in their usual order, with the panel each belongs to. */
  controls: { id: string; home: string }[];
  /** Panels controls can be dropped into (parameter panels; custom ones always can). */
  accepts: (panel: string) => boolean;
  sideTabs: string[];
}

export const DEFAULT_WIDTH = 300;
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 640;

export const isCustom = (id: string) => id.startsWith('custom:');

export function defaultLayout(k: Known): PanelLayout {
  return { v: 1, a: [...k.a], b: [...k.b], moved: {}, order: {}, custom: [], widths: { a: DEFAULT_WIDTH, b: DEFAULT_WIDTH }, hide: { a: false, b: false }, swap: false, sideTabs: [...k.sideTabs] };
}

const clampWidth = (w: unknown) => (typeof w === 'number' && Number.isFinite(w) ? Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))) : DEFAULT_WIDTH);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);

/** Puts each missing id into `list` just after the id that comes before it in `usual` (or first). */
function fillIn(list: string[], usual: string[], missing: string[]): string[] {
  const out = [...list];
  for (const id of missing) {
    const i = usual.indexOf(id);
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(usual[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
  }
  return out;
}

/** A layout that is safe to use: whatever was saved (or nothing), checked against what exists now. */
export function normaliseLayout(raw: unknown, k: Known): PanelLayout {
  const d = defaultLayout(k);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<PanelLayout>;
  const custom: CustomPanel[] = [];
  for (const c of Array.isArray(r.custom) ? r.custom : []) {
    if (c && typeof c.id === 'string' && isCustom(c.id) && !custom.some((x) => x.id === c.id)) custom.push({ id: c.id, name: String(c.name || 'My panel').slice(0, 60) });
  }
  const panels = new Set([...k.a, ...k.b, ...custom.map((c) => c.id)]);
  const seen = new Set<string>();
  const keep = (list: string[]) =>
    list.filter((id) => {
      if (!panels.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  let a = keep(strings(r.a));
  let b = keep(strings(r.b));
  // a panel with no place goes back to the column it starts in; a custom panel to the Parameters column
  a = fillIn(a, k.a, k.a.filter((id) => !seen.has(id)));
  b = fillIn(b, k.b, k.b.filter((id) => !seen.has(id)));
  for (const c of custom) if (!seen.has(c.id)) a.push(c.id);

  const controls = new Set(k.controls.map((c) => c.id));
  const moved: Record<string, string> = {};
  for (const [pid, panel] of Object.entries(r.moved && typeof r.moved === 'object' ? r.moved : {})) {
    const home = k.controls.find((c) => c.id === pid)?.home;
    if (home && typeof panel === 'string' && panel !== home && panels.has(panel) && (isCustom(panel) || k.accepts(panel))) moved[pid] = panel;
  }
  const order: Record<string, string[]> = {};
  for (const [panel, list] of Object.entries(r.order && typeof r.order === 'object' ? r.order : {})) {
    if (!panels.has(panel)) continue;
    const ids = [...new Set(strings(list))].filter((id) => controls.has(id));
    if (ids.length) order[panel] = ids;
  }
  const knownTabs = new Set(k.sideTabs);
  const tabs = [...new Set(strings(r.sideTabs))].filter((t) => knownTabs.has(t));
  return {
    v: 1,
    a,
    b,
    moved,
    order,
    custom,
    widths: { a: clampWidth(r.widths?.a), b: clampWidth(r.widths?.b) },
    hide: { a: !!r.hide?.a, b: !!r.hide?.b },
    swap: !!r.swap,
    sideTabs: fillIn(tabs, k.sideTabs, k.sideTabs.filter((t) => !tabs.includes(t))),
  };
}

/** The panel a control shows in now. */
export const panelOf = (l: PanelLayout, id: string, home: string) => l.moved[id] ?? home;

/** The controls in `panel`, in the order they show. */
export function controlsIn(l: PanelLayout, panel: string, k: Pick<Known, 'controls'>): string[] {
  const here = k.controls.filter((c) => panelOf(l, c.id, c.home) === panel).map((c) => c.id);
  const set = new Set(here);
  const listed = (l.order[panel] ?? []).filter((id) => set.has(id));
  const rest = here.filter((id) => !listed.includes(id));
  // controls the panel has never had listed (new ones, or ones from elsewhere) fall in at their usual place
  return fillIn(listed, here, rest);
}

export const sideOf = (l: PanelLayout, panel: string): Side | null => (l.a.includes(panel) ? 'a' : l.b.includes(panel) ? 'b' : null);

/** Move a panel into a column, before `before` (or to the end). */
export function movePanel(l: PanelLayout, panel: string, side: Side, before: string | null): PanelLayout {
  if (!sideOf(l, panel) || before === panel) return l;
  const a = l.a.filter((id) => id !== panel);
  const b = l.b.filter((id) => id !== panel);
  const list = side === 'a' ? a : b;
  const i = before ? list.indexOf(before) : -1;
  list.splice(i < 0 ? list.length : i, 0, panel);
  return { ...l, a, b, hide: { ...l.hide, [side]: false } };
}

/** One step up (-1) or down (+1) in its column. */
export function nudgePanel(l: PanelLayout, panel: string, dir: -1 | 1): PanelLayout {
  const side = sideOf(l, panel);
  if (!side) return l;
  const list = l[side];
  const i = list.indexOf(panel);
  const j = i + dir;
  if (j < 0 || j >= list.length) return l;
  return movePanel(l, panel, side, dir < 0 ? list[j] : (list[j + 1] ?? null));
}

/** Move a control into `panel`, before control `before` (or to the end of the panel). */
export function moveControl(l: PanelLayout, id: string, panel: string, before: string | null, k: Known): PanelLayout {
  const c = k.controls.find((x) => x.id === id);
  if (!c || before === id) return l;
  if (!isCustom(panel) && !k.accepts(panel)) return l;
  if (isCustom(panel) && !l.custom.some((p) => p.id === panel)) return l;
  const from = panelOf(l, id, c.home);
  const moved = { ...l.moved };
  if (panel === c.home) delete moved[id];
  else moved[id] = panel;
  const next = { ...l, moved };
  const list = controlsIn(l, panel, k).filter((x) => x !== id);
  const i = before ? list.indexOf(before) : -1;
  list.splice(i < 0 ? list.length : i, 0, id);
  const order = { ...l.order, [panel]: list };
  if (from !== panel) {
    const left = (order[from] ?? []).filter((x) => x !== id);
    if (left.length) order[from] = left;
    else delete order[from];
  }
  return { ...next, order };
}

/**
 * One step up or down. Past the top or bottom of its panel it goes into the
 * next panel that takes controls, in screen order (Parameters column, then Inspector column).
 */
export function nudgeControl(l: PanelLayout, id: string, dir: -1 | 1, k: Known, shown?: (panel: string) => string[]): PanelLayout {
  const c = k.controls.find((x) => x.id === id);
  if (!c) return l;
  const panel = panelOf(l, id, c.home);
  const list = shown ? shown(panel) : controlsIn(l, panel, k);
  const i = list.indexOf(id);
  const j = i + dir;
  if (i >= 0 && j >= 0 && j < list.length) return moveControl(l, id, panel, dir < 0 ? list[j] : (list[j + 1] ?? null), k);
  const order = [...l.a, ...l.b].filter((p) => isCustom(p) || k.accepts(p));
  const at = order.indexOf(panel);
  const to = order[at + dir];
  if (!to) return l;
  const there = shown ? shown(to) : controlsIn(l, to, k);
  return moveControl(l, id, to, dir < 0 ? null : (there[0] ?? null), k);
}

/** Put a control back in its own panel. */
export function sendHome(l: PanelLayout, id: string): PanelLayout {
  if (!(id in l.moved)) return l;
  const moved = { ...l.moved };
  const from = moved[id];
  delete moved[id];
  const order = { ...l.order };
  if (order[from]) order[from] = order[from].filter((x) => x !== id);
  return { ...l, moved, order };
}

/** Make a new empty panel at the top of a column. Returns the layout and the new id. */
export function addCustom(l: PanelLayout, name: string, side: Side = 'a', id = `custom:${Math.random().toString(36).slice(2, 9)}`): { layout: PanelLayout; id: string } {
  const p = { id, name: name.trim().slice(0, 60) || 'My panel' };
  const list = [id, ...l[side]];
  return { layout: { ...l, custom: [...l.custom, p], [side]: list, hide: { ...l.hide, [side]: false } }, id };
}

export function renameCustom(l: PanelLayout, id: string, name: string): PanelLayout {
  const n = name.trim().slice(0, 60);
  if (!n) return l;
  return { ...l, custom: l.custom.map((c) => (c.id === id ? { ...c, name: n } : c)) };
}

/** Remove a panel the person made; its controls go back to their own panels. */
export function removeCustom(l: PanelLayout, id: string): PanelLayout {
  if (!l.custom.some((c) => c.id === id)) return l;
  const moved = Object.fromEntries(Object.entries(l.moved).filter(([, p]) => p !== id));
  const order = { ...l.order };
  delete order[id];
  return { ...l, custom: l.custom.filter((c) => c.id !== id), a: l.a.filter((x) => x !== id), b: l.b.filter((x) => x !== id), moved, order };
}

/** Put one panel's controls back how they started: its own controls home and in their usual order, visitors back to theirs. */
export function resetPanel(l: PanelLayout, panel: string, k: Known): PanelLayout {
  const own = new Set(k.controls.filter((c) => c.home === panel).map((c) => c.id));
  const moved = Object.fromEntries(Object.entries(l.moved).filter(([id, p]) => p !== panel && !own.has(id)));
  const order = { ...l.order };
  delete order[panel];
  for (const p of Object.keys(order)) {
    order[p] = order[p].filter((id) => !own.has(id));
    if (!order[p].length) delete order[p];
  }
  return { ...l, moved, order };
}

/** Number of controls not in their usual place or order (for "Reset this panel" and the menu). */
export const changedControls = (l: PanelLayout) => Object.keys(l.moved).length + Object.keys(l.order).length;

/** Move a sidebar tab before another (or to the end). */
export function moveSideTab(l: PanelLayout, tab: string, before: string | null): PanelLayout {
  if (!l.sideTabs.includes(tab) || tab === before) return l;
  const list = l.sideTabs.filter((t) => t !== tab);
  const i = before ? list.indexOf(before) : -1;
  list.splice(i < 0 ? list.length : i, 0, tab);
  return { ...l, sideTabs: list };
}
