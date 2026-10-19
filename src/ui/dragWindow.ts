// Drag a panel that floats over a view by its title bar, the same way the
// floating workspace panes move. The spot is kept per panel (and across
// reloads) and is pulled back inside the view if the view gets smaller.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type Spot = { x: number; y: number } | null;

const KEY = 'strata.panelSpots.v1';

function readSpots(): Record<string, Spot> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveSpot(id: string, spot: Spot) {
  try {
    const all = readSpots();
    if (spot) all[id] = spot;
    else delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode: the spot just isn't remembered */
  }
}

/** Keep the panel inside its view (as much of it as fits), so its title bar can always be grabbed again. */
function clamp(el: HTMLElement, x: number, y: number): { x: number; y: number } {
  const parent = el.offsetParent as HTMLElement | null;
  const pw = parent?.clientWidth ?? window.innerWidth;
  const ph = parent?.clientHeight ?? window.innerHeight;
  return {
    x: Math.round(Math.min(Math.max(x, 0), Math.max(0, pw - el.offsetWidth))),
    y: Math.round(Math.min(Math.max(y, 0), Math.max(0, ph - el.offsetHeight))),
  };
}

/**
 * A movable panel: spread `bind` on its title bar and `style` on the panel.
 * With no saved spot the panel stays where its CSS puts it. Double-click the
 * title bar (or call `reset`) to put it back there.
 */
export function useDragWindow(id: string) {
  const ref = useRef<HTMLElement | null>(null);
  const [spot, setSpot] = useState<Spot>(() => readSpots()[id] ?? null);

  // pull a remembered spot back inside a view that is smaller than when it was saved
  useEffect(() => {
    const el = ref.current;
    if (!el || !spot) return;
    const fixed = clamp(el, spot.x, spot.y);
    if (fixed.x !== spot.x || fixed.y !== spot.y) setSpot(fixed);
  }, [spot]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const el = ref.current;
      if (!el || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const start = { x: el.offsetLeft, y: el.offsetTop };
      let last: Spot = start;
      const mv = (ev: PointerEvent) => {
        last = clamp(el, start.x + ev.clientX - sx, start.y + ev.clientY - sy);
        setSpot(last);
      };
      const up = () => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        saveSpot(id, last);
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
    },
    [id],
  );

  const reset = useCallback(() => {
    setSpot(null);
    saveSpot(id, null);
  }, [id]);

  return {
    ref,
    moved: !!spot,
    reset,
    style: spot ? { left: spot.x, top: spot.y, right: 'auto', bottom: 'auto', transform: 'none' } : undefined,
    bind: { onPointerDown, onDoubleClick: reset, className: 'title-bar ws-grab' },
  };
}
