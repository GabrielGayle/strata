// One list of everything the app is waiting on, so every wait can show the
// same animated Windows 98 progress window instead of a bare "Working…".
// Anything slow calls beginBusy (or trackBusy for a promise) and ends it when
// done; BusyWindow and the status bar light read the list.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

/** Picks the little animation: what is being moved from where to where. */
export type BusyScene =
  | 'depth' // photo → depth server → grey depth picture
  | 'map' // globe → terrain
  | 'engine' // plates being sliced and checked
  | 'export' // plates → zip
  | 'pack' // plates → printed page
  | 'shadow' // sun → plates → wall
  | 'save' // project → disk
  | 'video' // film → stills
  | 'search' // magnifier over a map
  | 'load'; // hourglass

export interface BusyTask {
  id: number;
  scene: BusyScene;
  /** Window title, e.g. "Depth from photo". */
  title: string;
  /** The current step, e.g. "Waking the depth server…". */
  detail?: string;
  /** Known progress; leave out for a sliding bar. */
  done?: number;
  total?: number;
  /** Best guess at the whole wait, for a timed bar and "about N s left". */
  expectMs?: number;
  startedAt: number;
  /** Show the progress window (otherwise only the status bar light). */
  window: boolean;
  /** Wait this long before the window appears, so quick jobs don't flash one. */
  delayMs?: number;
  cancel?: () => void;
}

export type BusyInput = Omit<BusyTask, 'id' | 'startedAt' | 'window'> & { window?: boolean };

export interface BusyHandle {
  id: number;
  update(patch: Partial<Omit<BusyTask, 'id' | 'startedAt'>>): void;
  end(): void;
}

interface BusyState {
  tasks: BusyTask[];
}

export const useBusy = create<BusyState>(() => ({ tasks: [] }));

let nextId = 1;

export function beginBusy(input: BusyInput, now = Date.now()): BusyHandle {
  const id = nextId++;
  const task: BusyTask = { window: true, ...input, id, startedAt: now };
  useBusy.setState((s) => ({ tasks: [...s.tasks, task] }));
  let ended = false;
  return {
    id,
    update(patch) {
      if (ended) return;
      useBusy.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    },
    end() {
      if (ended) return;
      ended = true;
      useBusy.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    },
  };
}

/** Shows `input` until `work` settles, then returns its result (or throws its error). */
export async function trackBusy<T>(input: BusyInput, work: Promise<T> | ((h: BusyHandle) => Promise<T>)): Promise<T> {
  const h = beginBusy(input);
  try {
    return await (typeof work === 'function' ? work(h) : work);
  } finally {
    h.end();
  }
}

/**
 * For work that blocks the main thread (exports, build pack): show the window,
 * let the browser paint it, then run. The animations only move transforms, so
 * the compositor keeps them going while the page itself is stuck.
 */
export async function busyThen<T>(input: BusyInput, work: () => T): Promise<T> {
  const h = beginBusy({ delayMs: 0, ...input });
  try {
    await nextPaint();
    return work();
  } finally {
    h.end();
  }
}

export const nextPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') return resolve();
    // one frame to lay out, one more so that frame has actually reached the screen
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

/** 0..1 when progress is known or can be timed, else null (sliding bar). */
export function busyFraction(t: Pick<BusyTask, 'done' | 'total' | 'expectMs' | 'startedAt'>, now = Date.now()): number | null {
  if (t.total && t.total > 0 && t.done !== undefined) return Math.max(0, Math.min(1, t.done / t.total));
  if (t.expectMs && t.expectMs > 0) {
    // eases towards 95% and never claims done before the work is
    const x = (now - t.startedAt) / t.expectMs;
    return Math.min(0.95, x < 1 ? x * 0.9 : 0.9 + 0.05 * (1 - Math.exp(-(x - 1) * 2)));
  }
  return null;
}

/** "about 30 s left", "a few more seconds", or null when there's no estimate. */
export function busyRemaining(t: Pick<BusyTask, 'expectMs' | 'startedAt'>, now = Date.now()): string | null {
  if (!t.expectMs) return null;
  const left = t.expectMs - (now - t.startedAt);
  if (left <= 3000) return 'a few more seconds';
  const s = Math.ceil(left / 1000);
  return s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s >= 20 ? Math.round(s / 5) * 5 : s} s left`;
}

export function busyElapsed(t: Pick<BusyTask, 'startedAt'>, now = Date.now()): string {
  const s = Math.floor((now - t.startedAt) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/**
 * Keeps a busy task up while `on` is true, for waits that live in store state
 * rather than in one function (map terrain, background checks). Title and
 * detail follow `input`; the window joins in once it has run `windowAfterMs`
 * (Infinity: the status bar light only, never a window).
 */
export function useBusyWhile(on: boolean, input: Omit<BusyInput, 'window'>, windowAfterMs = 0) {
  const handle = useRef<BusyHandle | null>(null);
  const { title, detail } = input;
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!on) return;
    const h = beginBusy({ ...latest.current, window: windowAfterMs === 0, delayMs: windowAfterMs === 0 ? undefined : 0 });
    handle.current = h;
    const t = windowAfterMs > 0 && Number.isFinite(windowAfterMs) ? setTimeout(() => h.update({ window: true }), windowAfterMs) : undefined;
    return () => {
      clearTimeout(t);
      h.end();
      handle.current = null;
    };
  }, [on, windowAfterMs]);
  useEffect(() => {
    handle.current?.update({ title, detail });
  }, [title, detail]);
}

/** What the depth window says at each point of the wait. */
export function depthStep(elapsedMs: number, est: { bootMs: number; totalMs: number }): string {
  if (elapsedMs < 1500) return 'Sending the photo to the depth server…';
  if (elapsedMs < est.bootMs) return 'Waking the depth server. It sleeps after 5 idle minutes and takes about 45 s to start.';
  if (elapsedMs < est.totalMs + 15_000) return 'Reading depth from the photo…';
  return 'Taking longer than usual. Still waiting for the depth server…';
}
