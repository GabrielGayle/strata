// Dragging panels and controls about (Blender-style): what is being dragged,
// where it would land, and the handlers the side columns, panels and control
// rows hang on themselves. HTML5 drag and drop, started only from a grip, so
// sliders and text boxes keep working as before. The grips also answer the
// arrow keys, for keyboards and screen readers.
import { create } from 'zustand';
import type { DragEvent } from 'react';
import { isCustom, type Side } from '../core/panelLayout';
import { KNOWN, homeOf, panelGroup, usePanels } from '../state/panelLayout';
import { useStore } from '../state/store';

export type Drag = { kind: 'panel' | 'control'; id: string } | null;
/** Where a drop would land: before `before` (null = at the end) in `in`, a column or a panel. */
export type Spot = { in: string; before: string | null } | null;

export const useDrag = create<{ drag: Drag; spot: Spot }>(() => ({ drag: null, spot: null }));

const MIME = { panel: 'text/x-strata-panel', control: 'text/x-strata-control' } as const;

const end = () => useDrag.setState({ drag: null, spot: null });
if (typeof window !== 'undefined') {
  window.addEventListener('dragend', end);
  window.addEventListener('drop', () => setTimeout(end, 0));
}

/** Handlers for a grip that starts a drag. */
export function gripProps(kind: 'panel' | 'control', id: string, label: string) {
  return {
    draggable: true,
    'aria-label': `Move ${label}`,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData(MIME[kind], id);
      e.dataTransfer.effectAllowed = 'move';
      const row = (e.currentTarget as HTMLElement).closest(kind === 'panel' ? '.section' : '.ctl');
      if (row) e.dataTransfer.setDragImage(row, 12, 10);
      // let the browser take its drag picture before the drop marks show
      setTimeout(() => useDrag.setState({ drag: { kind, id }, spot: null }), 0);
    },
    onDragEnd: end,
  };
}

const after = (e: DragEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};
const setSpot = (spot: Spot) => {
  const cur = useDrag.getState().spot;
  if (cur?.in !== spot?.in || cur?.before !== spot?.before) useDrag.setState({ spot });
};
const accepts = (panel: string) => isCustom(panel) || KNOWN.accepts(panel);

/** On a panel: a dragged panel goes above or below it; a dragged control goes to the end of it. */
export function panelDropProps(panel: string, side: Side, next: string | null) {
  return {
    onDragOver: (e: DragEvent) => {
      const d = useDrag.getState().drag;
      if (!d) return;
      if (d.kind === 'control' && !accepts(panel)) return;
      e.preventDefault();
      e.stopPropagation();
      if (d.kind === 'panel') setSpot(d.id === panel ? null : { in: side, before: after(e) ? next : panel });
      else setSpot({ in: panel, before: null });
    },
    onDrop: (e: DragEvent) => {
      const d = useDrag.getState().drag;
      const spot = useDrag.getState().spot;
      if (!d || !spot) return;
      e.preventDefault();
      e.stopPropagation();
      if (d.kind === 'panel') usePanels.getState().movePanel(d.id, spot.in as Side, spot.before);
      else dropControl(d.id, spot.in, spot.before);
      end();
    },
  };
}

/** On a control row: a dragged control goes above or below it. */
export function controlDropProps(id: string, panel: string, next: string | null) {
  return {
    onDragOver: (e: DragEvent) => {
      const d = useDrag.getState().drag;
      if (d?.kind !== 'control') return;
      e.preventDefault();
      e.stopPropagation();
      setSpot(d.id === id ? null : { in: panel, before: after(e) ? next : id });
    },
  };
}

/** On a column's empty space: panels go to the end of it. */
export function columnDropProps(side: Side) {
  return {
    onDragOver: (e: DragEvent) => {
      if (useDrag.getState().drag?.kind !== 'panel') return;
      e.preventDefault();
      setSpot({ in: side, before: null });
    },
    onDrop: (e: DragEvent) => {
      const d = useDrag.getState().drag;
      if (d?.kind !== 'panel') return;
      e.preventDefault();
      usePanels.getState().movePanel(d.id, side, null);
      end();
    },
  };
}

function dropControl(id: string, panel: string, before: string | null) {
  usePanels.getState().moveControl(id, panel, before);
  openPanel(panel);
}

/** The ui.collapsed key that folds a panel. Parameter panels keep using their group name. */
export const foldKey = (panel: string) => panelGroup(panel) ?? panel;

/** Unfold a panel and show its column. */
export function openPanel(panel: string) {
  const st = useStore.getState();
  const key = foldKey(panel);
  if (st.ui.collapsed[key]) st.setUi({ collapsed: { ...st.ui.collapsed, [key]: false } });
  const p = usePanels.getState();
  const side = p.layout.a.includes(panel) ? 'a' : p.layout.b.includes(panel) ? 'b' : null;
  if (side && p.layout.hide[side]) p.toggleHide(side);
  if (side === 'a' && st.ui.leftPane === 'saves') st.setUi({ leftPane: 'params' });
}

/** The panel a parameter's row shows in now (its own group's, unless it was moved). */
export const panelOfParam = (id: string) => usePanels.getState().layout.moved[id] ?? homeOf(id);

/** Keys on a grip: arrows move it a step (Left / Right take a panel to the other column). */
export function gripKeys(kind: 'panel' | 'control', id: string, shown?: (panel: string) => string[]) {
  return (e: React.KeyboardEvent) => {
    const p = usePanels.getState();
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (dir) {
      e.preventDefault();
      if (kind === 'panel') p.nudgePanel(id, dir);
      else {
        p.nudgeControl(id, dir, shown);
        openPanel(panelOfParam(id));
      }
    } else if (kind === 'panel' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const side = p.layout.a.includes(id) ? 'a' : 'b';
      p.movePanel(id, side === 'a' ? 'b' : 'a', null);
    } else return;
    // keep the focus on the grip that moved
    const sel = kind === 'panel' ? `[data-grip-panel="${CSS.escape(id)}"]` : `[data-grip-control="${CSS.escape(id)}"]`;
    requestAnimationFrame(() => (document.querySelector(sel) as HTMLElement | null)?.focus());
  };
}
