// The Windows 98 progress windows for long waits, and the hourglass light in
// the status bar for every wait. Both read the list in busy.ts.
import { useEffect, useState, type ReactNode } from 'react';
import { BusyAnim, Hourglass, Progress98 } from './BusyAnim';
import { busyElapsed, busyFraction, busyRemaining, useBusy, useBusyWhile, type BusyTask } from './busy';
import { useStore } from '../state/store';

const SHOW_AFTER_MS = 400;
const MAX_WINDOWS = 3;

/** Re-renders a few times a second while `on`, for the clock and timed bars. */
function useNow(on: boolean, every = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [on, every]);
  return now;
}

/**
 * Waits the app tracks as state rather than as one call: map terrain builds,
 * the engine worker building plates (a preview while dragging only lights the
 * status bar), and the background checks after an edit (only worth a window when slow).
 */
export function useAppBusy(checksStale: boolean, engine: 'preview' | 'full' | null = null) {
  const map = useStore((s) => s.mapTerrain);
  useBusyWhile(map.phase === 'working', { scene: 'map', title: 'Building map terrain', detail: map.message || 'Fetching elevation…' });
  useBusyWhile(engine === 'preview', { scene: 'engine', title: 'Previewing plates', detail: 'Coarse plates while you drag. The full build follows when you let go.' }, Infinity);
  useBusyWhile(engine === 'full', { scene: 'engine', title: 'Building plates', detail: 'Slicing, carving and checking in the background. You can keep working.' }, 1500);
  useBusyWhile(checksStale && !engine, { scene: 'engine', title: 'Checking plates', detail: 'Fit checks, nesting, moulds and the cut list are catching up with your last edit.' }, 1500);
}

export function BusyWindows() {
  const tasks = useBusy((s) => s.tasks);
  const now = useNow(tasks.length > 0);
  const shown = tasks.filter((t) => t.window && now - t.startedAt >= (t.delayMs ?? SHOW_AFTER_MS)).slice(-MAX_WINDOWS);
  if (!shown.length) return null;
  return (
    <div className="busy-windows">
      {shown.map((t) => (
        <BusyWindow key={t.id} task={t} now={now} />
      ))}
    </div>
  );
}

function BusyWindow({ task: t, now }: { task: BusyTask; now: number }) {
  const fraction = busyFraction(t, now);
  const left = busyRemaining(t, now);
  const count = t.total && t.done !== undefined ? `${t.done} of ${t.total}` : null;
  return (
    <section className="window busy-window" aria-label={t.title} data-testid="busy-window">
      <div className="title-bar">
        <div className="title-bar-text">{t.title}</div>
      </div>
      <div className="window-body">
        <BusyAnim scene={t.scene} />
        <p className="busy-detail" role="status">
          {t.detail ?? 'Working…'}
        </p>
        <Progress98 fraction={fraction} label={t.title} />
        <div className="busy-foot">
          <span className="busy-time">
            {[count, `${busyElapsed(t, now)} so far`, left].filter(Boolean).join(' · ')}
          </span>
          {t.cancel && (
            <button type="button" onClick={t.cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Status bar field: a draining hourglass and what's happening, while anything is. */
export function BusyLight() {
  const tasks = useBusy((s) => s.tasks);
  if (!tasks.length) return null;
  const t = tasks[tasks.length - 1];
  const more = tasks.length - 1;
  return (
    <p className="status-bar-field busy-light" title={tasks.map((x) => `${x.title}: ${x.detail ?? 'working'}`).join('\n')} data-testid="busy-light">
      <Hourglass small />
      <span>
        {t.title}
        {more > 0 ? ` +${more} more` : ''}
      </span>
    </p>
  );
}

/** Drop-in for the bare "Loading…" placeholders (lazy views, previews). */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty busy-loading" role="status">
      <Hourglass />
      <span>{label}</span>
    </div>
  );
}

/** An inline hourglass + words, for buttons and notes that say "…ing". */
export function BusyNote({ children }: { children: ReactNode }) {
  return (
    <span className="busy-note" role="status">
      <Hourglass small />
      {children}
    </span>
  );
}
