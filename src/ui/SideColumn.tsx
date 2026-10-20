// The two side columns, Parameters and Inspector, as docks: each shows its
// panels in the order the layout says, takes panels dropped from the other,
// and has an edge you drag to make it wider (double-click for the usual width).
import { type PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_WIDTH, type Side } from '../core/panelLayout';
import { usePanels } from '../state/panelLayout';
import { useStore } from '../state/store';
import ParamHead, { CustomParamPanel, ParamGroupPanel } from './ParamPanel';
import { InspectorHead, InspectorPanel, type PanelPlace } from './Inspector';
import { columnDropProps, useDrag } from './panelDrag';
// connects the 3D sidebar's width to saved layouts, before any layout is saved
import './sidebarState';

function PanelById({ panel }: { panel: PanelPlace }) {
  if (panel.id.startsWith('param:')) return <ParamGroupPanel group={panel.id.slice(6)} side={panel.side} next={panel.next} />;
  if (panel.id.startsWith('custom:')) return <CustomParamPanel id={panel.id} side={panel.side} next={panel.next} />;
  return <InspectorPanel panel={panel} />;
}

export default function SideColumn({ side }: { side: Side }) {
  const list = usePanels((s) => s.layout[side]);
  const hidden = usePanels((s) => s.layout.hide[side]);
  const leftPane = useStore((s) => s.ui.leftPane ?? 'params');
  const endSpot = useDrag((s) => s.drag?.kind === 'panel' && s.spot?.in === side && s.spot.before === null);
  const dragging = useDrag((s) => s.drag?.kind === 'panel');
  const panels = list.map((id, i) => <PanelById key={id} panel={{ id, side, next: list[i + 1] ?? null }} />);
  const showsPanels = side === 'b' || leftPane === 'params';
  return (
    <aside className={`${side === 'a' ? 'left' : 'right'} window${hidden ? ' col-hidden' : ''}${dragging ? ' col-dragging' : ''}`} data-column={side} data-hl={side === 'a' ? 'column-parameters' : 'column-inspector'}>
      {side === 'a' ? (
        <ParamHead>{panels}</ParamHead>
      ) : (
        <>
          <InspectorHead />
          {panels}
        </>
      )}
      {showsPanels && (
        <div className={`dock-end${endSpot ? ' drop-before' : ''}`} {...columnDropProps(side)} aria-hidden="true">
          {dragging && <span>Drop here for the bottom of this column</span>}
        </div>
      )}
    </aside>
  );
}

/** The grab edge on a column's inner side. */
export function ColumnEdge({ side }: { side: Side }) {
  const hidden = usePanels((s) => s.layout.hide[side]);
  const swap = usePanels((s) => s.layout.swap);
  // which screen side the column is on decides which way is wider
  const onLeft = (side === 'a') !== swap;
  if (hidden) return null;
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const col = document.querySelector(`[data-column="${side}"]`) as HTMLElement | null;
    if (!col) return;
    const r = col.getBoundingClientRect();
    const move = (ev: PointerEvent) => usePanels.getState().setWidth(side, onLeft ? ev.clientX - r.left : r.right - ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
    };
    document.body.classList.add('col-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`col-edge ${onLeft ? 'in-left' : 'in-right'}`}
      onPointerDown={onDown}
      onDoubleClick={() => usePanels.getState().setWidth(side, DEFAULT_WIDTH)}
      title="Drag to make this column wider or narrower. Double-click for the usual width."
      aria-hidden="true"
    />
  );
}

/** Grid widths for the app frame, from the layout. */
export function useColumnStyle(): { cls: string; style: Record<string, string> } {
  const l = usePanels((s) => s.layout);
  const w = (side: Side) => (l.hide[side] ? '0px' : `${l.widths[side]}px`);
  return {
    cls: l.swap ? ' swap' : '',
    style: { '--col-left': w(l.swap ? 'b' : 'a'), '--col-right': w(l.swap ? 'a' : 'b') },
  };
}
