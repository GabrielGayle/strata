// Workspace layouts: which view tabs sit where in the main area. A layout is a
// binary split tree of panes (each pane is its own tab strip with one tab
// showing) plus any floating panes. Every tab lives in exactly one pane.
// Pure functions only, so the UI can treat layouts as immutable values.

export type Zone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface Pane {
  kind: 'pane';
  id: string;
  tabs: string[];
  active: string;
}
export interface Split {
  kind: 'split';
  id: string;
  /** 'row' puts a left of b; 'col' puts a above b. */
  dir: 'row' | 'col';
  /** Share of the space given to `a`, 0..1. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}
export type LayoutNode = Pane | Split;

export interface Float extends Omit<Pane, 'kind'> {
  /** Position and size in px inside the main area. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  root: LayoutNode;
  floats: Float[];
}

export interface Workspace {
  id: string;
  name: string;
  layout: Layout;
  /** Starting workspace this one was made from, so it can be reset. */
  preset?: string;
}

export type DropTarget = { pane: string; zone: Zone } | { float: { x: number; y: number } };

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const pane = (tabs: string[], active = tabs[0], id = uid('p')): Pane => ({ kind: 'pane', id, tabs, active });
export const split = (dir: 'row' | 'col', a: LayoutNode, b: LayoutNode, ratio = 0.5, id = uid('s')): Split => ({ kind: 'split', id, dir, ratio, a, b });

export const MIN_RATIO = 0.12;
const clampRatio = (r: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, Number.isFinite(r) ? r : 0.5));

/** Every pane in the docked tree, in reading order. */
export function panes(n: LayoutNode): Pane[] {
  return n.kind === 'pane' ? [n] : [...panes(n.a), ...panes(n.b)];
}

/** The pane or float holding a tab. */
export function findTab(l: Layout, tab: string): Pane | Float | undefined {
  return panes(l.root).find((p) => p.tabs.includes(tab)) ?? l.floats.find((f) => f.tabs.includes(tab));
}

/** Every tab currently showing (the active tab of each pane and float). */
export function visibleTabs(l: Layout): string[] {
  return [...panes(l.root), ...l.floats].map((p) => p.active);
}

function mapNode(n: LayoutNode, f: (p: Pane) => LayoutNode | null): LayoutNode | null {
  if (n.kind === 'pane') return f(n);
  const a = mapNode(n.a, f);
  const b = mapNode(n.b, f);
  if (!a) return b;
  if (!b) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

function withoutTab<T extends Pane | Float>(p: T, tab: string): T | null {
  if (!p.tabs.includes(tab)) return p;
  const i = p.tabs.indexOf(tab);
  const tabs = p.tabs.filter((t) => t !== tab);
  if (!tabs.length) return null;
  return { ...p, tabs, active: p.active === tab ? tabs[Math.min(i, tabs.length - 1)] : p.active };
}

/** Take a tab out of wherever it is; empty panes close up. Null if that would leave no docked pane. */
function removeTab(l: Layout, tab: string): Layout | null {
  const root = mapNode(l.root, (p) => withoutTab(p, tab));
  if (!root) return null;
  return { root, floats: l.floats.map((f) => withoutTab(f, tab)).filter((f): f is Float => !!f) };
}

/** Show a tab in the pane that holds it. */
export function revealTab(l: Layout, tab: string): Layout {
  const holder = findTab(l, tab);
  if (!holder || holder.active === tab) return l;
  const root = mapNode(l.root, (p) => (p.id === holder.id ? { ...p, active: tab } : p))!;
  return { root, floats: l.floats.map((f) => (f.id === holder.id ? { ...f, active: tab } : f)) };
}

/** Move a tab into a pane (center), beside it (an edge, which splits that pane) or into a new floating pane. */
export function moveTab(l: Layout, tab: string, to: DropTarget, floatSize = { w: 520, h: 380 }): Layout {
  const from = findTab(l, tab);
  if (!from) return l;
  if ('float' in to) {
    if (from.tabs.length === 1 && l.floats.some((f) => f.id === from.id)) {
      return { ...l, floats: l.floats.map((f) => (f.id === from.id ? { ...f, x: to.float.x, y: to.float.y } : f)) };
    }
    const rest = removeTab(l, tab);
    if (!rest) return l;
    return { ...rest, floats: [...rest.floats, { id: uid('f'), tabs: [tab], active: tab, x: to.float.x, y: to.float.y, ...floatSize }] };
  }
  const target = to.pane;
  // dropping a pane's only tab onto its own pane does nothing
  if (from.id === target && (to.zone === 'center' || from.tabs.length === 1)) return revealTab(l, tab);
  const rest = removeTab(l, tab);
  if (!rest) return l;
  const inFloat = rest.floats.find((f) => f.id === target);
  if (inFloat) {
    return { ...rest, floats: rest.floats.map((f) => (f.id === target ? { ...f, tabs: [...f.tabs, tab], active: tab } : f)) };
  }
  if (!panes(rest.root).some((p) => p.id === target)) return l;
  const root = mapNode(rest.root, (p) => {
    if (p.id !== target) return p;
    if (to.zone === 'center') return { ...p, tabs: [...p.tabs, tab], active: tab };
    const fresh = pane([tab]);
    const dir = to.zone === 'left' || to.zone === 'right' ? 'row' : 'col';
    return to.zone === 'left' || to.zone === 'top' ? split(dir, fresh, p) : split(dir, p, fresh);
  })!;
  return { ...rest, root };
}

/** Put a floating pane's tabs back into the first docked pane. */
export function dockFloat(l: Layout, floatId: string): Layout {
  const f = l.floats.find((x) => x.id === floatId);
  if (!f) return l;
  const first = panes(l.root)[0];
  const root = mapNode(l.root, (p) => (p.id === first.id ? { ...p, tabs: [...p.tabs, ...f.tabs], active: f.active } : p))!;
  return { root, floats: l.floats.filter((x) => x.id !== floatId) };
}

export function setFloatRect(l: Layout, floatId: string, r: Partial<Pick<Float, 'x' | 'y' | 'w' | 'h'>>): Layout {
  return { ...l, floats: l.floats.map((f) => (f.id === floatId ? { ...f, ...r } : f)) };
}

/** Bring a float to the front. */
export function raiseFloat(l: Layout, floatId: string): Layout {
  const f = l.floats.find((x) => x.id === floatId);
  if (!f || l.floats[l.floats.length - 1] === f) return l;
  return { ...l, floats: [...l.floats.filter((x) => x !== f), f] };
}

export function setRatio(l: Layout, splitId: string, ratio: number): Layout {
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'pane') return n;
    if (n.id === splitId) return { ...n, ratio: clampRatio(ratio) };
    const a = walk(n.a);
    const b = walk(n.b);
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  return { ...l, root: walk(l.root) };
}

/** Which zone of a pane a point falls in: near an edge splits, the middle joins. */
export function zoneAt(x: number, y: number, w: number, h: number, edge = 0.25): Zone {
  const fx = x / w;
  const fy = y / h;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const [best, dist] = (Object.entries(d) as [Zone, number][]).sort((p, q) => p[1] - q[1])[0];
  return dist < edge ? best : 'center';
}

/**
 * Make a stored layout safe to use: drops unknown or repeated tabs, fixes
 * broken nodes and ratios, and puts any tab that is missing (a new view, say)
 * into the first pane. Returns null if nothing usable is left.
 */
export function normalise(raw: unknown, allTabs: readonly string[]): Layout | null {
  const seen = new Set<string>();
  const known = new Set(allTabs);
  const cleanPane = (p: any): { id: string; tabs: string[]; active: string } | null => {
    if (!p || !Array.isArray(p.tabs)) return null;
    const tabs: string[] = [];
    for (const t of p.tabs) {
      if (typeof t === 'string' && known.has(t) && !seen.has(t)) {
        seen.add(t);
        tabs.push(t);
      }
    }
    if (!tabs.length) return null;
    return { id: typeof p.id === 'string' ? p.id : uid('p'), tabs, active: tabs.includes(p.active) ? p.active : tabs[0] };
  };
  const walk = (n: any, depth: number): LayoutNode | null => {
    if (!n || depth > 32) return null;
    if (n.kind === 'pane') {
      const p = cleanPane(n);
      return p && { kind: 'pane', ...p };
    }
    if (n.kind === 'split') {
      const a = walk(n.a, depth + 1);
      const b = walk(n.b, depth + 1);
      if (!a || !b) return a ?? b;
      return { kind: 'split', id: typeof n.id === 'string' ? n.id : uid('s'), dir: n.dir === 'col' ? 'col' : 'row', ratio: clampRatio(n.ratio), a, b };
    }
    return null;
  };
  const l = raw as any;
  let root = walk(l?.root, 0);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const floats: Float[] = (Array.isArray(l?.floats) ? l.floats : [])
    .map((f: any) => {
      const p = cleanPane(f);
      return p && { ...p, x: num(f.x, 40), y: num(f.y, 40), w: Math.max(200, num(f.w, 520)), h: Math.max(140, num(f.h, 380)) };
    })
    .filter(Boolean);
  const missing = allTabs.filter((t) => !seen.has(t));
  if (!root) {
    if (!missing.length) return null;
    root = pane(missing);
  } else if (missing.length) {
    const first = panes(root)[0];
    root = mapNode(root, (p) => (p.id === first.id ? { ...p, tabs: [...p.tabs, ...missing] } : p))!;
  }
  return { root, floats };
}
