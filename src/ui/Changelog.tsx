// Help › Changelog: what's new and fixed, newest first. "Show me" opens the right view,
// panel or menu and lights up the control the change lives in.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { useStore } from '../state/store';
import { PARAMS } from '../core/params';
import { CHANGELOG, type ChangeEntry, type ChangeTarget } from './changelogEntries';

const SEEN_KEY = 'strata:changelog-seen';
const entryKey = (e: ChangeEntry) => `${e.date}|${e.title}`;
function readSeen(): string | null {
  try {
    const k = localStorage.getItem(SEEN_KEY);
    // a first visit starts with everything seen: nothing pops up and no badge
    if (k === null && CHANGELOG[0]) localStorage.setItem(SEEN_KEY, entryKey(CHANGELOG[0]));
    return k ?? (CHANGELOG[0] ? entryKey(CHANGELOG[0]) : null);
  } catch {
    return CHANGELOG[0] ? entryKey(CHANGELOG[0]) : null;
  }
}
const useChangelog = create<{ open: boolean; spot: ChangeEntry | null; seen: string | null }>(() => ({ open: false, spot: null, seen: readSeen() }));

function markAllSeen() {
  const top = CHANGELOG[0];
  if (!top) return;
  try {
    localStorage.setItem(SEEN_KEY, entryKey(top));
  } catch {
    /* private window or blocked storage */
  }
  useChangelog.setState({ seen: entryKey(top) });
}

export const openChangelog = () => {
  useChangelog.setState({ open: true, spot: null });
  markAllSeen();
};
const closeChangelog = () => useChangelog.setState({ open: false });

/** Entries added since the changelog was last opened. */
export function useUnseenChanges(): number {
  const seen = useChangelog((s) => s.seen);
  const i = CHANGELOG.findIndex((e) => entryKey(e) === seen);
  return i < 0 ? 0 : i;
}

const shown = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement && el.getClientRects().length > 0;
const byName = (name: string) => {
  const q = CSS.escape(name);
  return [...document.querySelectorAll(`[data-hl~="${q}"], [data-testid="${q}"]`)].find(shown) ?? null;
};
const isOpen = (el: HTMLElement) =>
  el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.classList.contains('on');

/** Polls until `find` gives an element on screen, or gives up after `ms`. */
function waitFor(find: () => HTMLElement | null, ms: number, alive: () => boolean): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (!alive()) return resolve(null);
      const el = find();
      if (el || performance.now() - t0 > ms) return resolve(el);
      setTimeout(tick, 100);
    };
    tick();
  });
}

const sel = (q: string) => () => [...document.querySelectorAll(q)].find(shown) ?? null;

/** Where a target ends, best first: the last `path` name, else the param row, its panel, the tab. */
function finalFinds(t: ChangeTarget, group: string | undefined): (() => HTMLElement | null)[] {
  const last = t.path?.[t.path.length - 1];
  if (last) return [() => byName(last)];
  return [
    ...(t.param ? [sel(`[data-param="${CSS.escape(t.param)}"]`)] : []),
    ...(group ? [sel(`.section[data-group="${CSS.escape(group)}"]`)] : []),
    ...(t.tab ? [sel(`[data-tab="${CSS.escape(t.tab)}"]`)] : []),
  ];
}

/** Opens what the target needs and returns the control to light up (null when it isn't on screen now). */
export async function revealTarget(t: ChangeTarget, alive: () => boolean = () => true): Promise<HTMLElement | null> {
  const st = useStore.getState();
  const group = t.group ?? (t.param ? PARAMS.find((p) => p.id === t.param)?.group : undefined);
  if (t.tab) st.setUi({ tab: t.tab });
  if (t.ui) st.setUi(t.ui);
  if (group) st.setUi({ leftPane: 'params', filter: '', collapsed: { ...useStore.getState().ui.collapsed, [group]: false } });
  for (const name of (t.path ?? []).slice(0, -1)) {
    const el = await waitFor(() => byName(name), 3000, alive);
    if (!el) return null;
    if (!isOpen(el)) el.click();
  }
  // a param row can be hidden (its panel switched off): then light the panel, then the tab
  const finds = finalFinds(t, group);
  for (const [i, find] of finds.entries()) {
    const el = await waitFor(find, i === finds.length - 1 ? 3000 : 1500, alive);
    if (el) return el;
  }
  return null;
}

function ChangelogWindow() {
  const [kind, setKind] = useState<'all' | 'new' | 'fix'>('all');
  const days = useMemo(() => {
    const out: { date: string; items: ChangeEntry[] }[] = [];
    for (const e of CHANGELOG) {
      if (kind !== 'all' && e.kind !== kind) continue;
      if (out[out.length - 1]?.date !== e.date) out.push({ date: e.date, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [kind]);
  const show = (e: ChangeEntry) => useChangelog.setState({ open: false, spot: e });
  return (
    <div className="pm-back help-back" onMouseDown={(e) => e.target === e.currentTarget && closeChangelog()}>
      <div className="window pm changelog" role="dialog" aria-modal="true" aria-label="Changelog" data-testid="changelog">
        <div className="title-bar">
          <div className="title-bar-text">Changelog</div>
          <div className="title-bar-controls">
            <button type="button" aria-label="Close" onClick={closeChangelog} />
          </div>
        </div>
        <div className="window-body changelog-body">
          <div className="field-row cl-filter">
            <span className="seg" role="group" aria-label="Show">
              {(['all', 'new', 'fix'] as const).map((k) => (
                <button key={k} type="button" className={`btn sm ${kind === k ? 'on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === 'all' ? 'All' : k === 'new' ? 'New' : 'Fixes'}
                </button>
              ))}
            </span>
            <span className="note">Click a change to see where it is.</span>
          </div>
          <div className="cl-list sunken-panel">
            {days.map((d) => (
              <section key={d.date} className="cl-day">
                <h3>{dayLabel(d.date)}</h3>
                {d.items.map((e) => {
                  const inner = (
                    <>
                      <span className={`cl-kind ${e.kind}`}>{e.kind === 'new' ? 'New' : 'Fix'}</span>
                      <span className="cl-text">
                        <span className="cl-title">{e.title}</span>
                        <span className="cl-desc">{e.body}</span>
                        <span className="cl-where">
                          {e.where}
                          {e.pr ? ` · #${e.pr}` : ''}
                        </span>
                      </span>
                      {e.target && <span className="cl-go">Show me ›</span>}
                    </>
                  );
                  return e.target ? (
                    <button key={entryKey(e)} type="button" className="cl-entry" onClick={() => show(e)} title={`Show where: ${e.where}`}>
                      {inner}
                    </button>
                  ) : (
                    <div key={entryKey(e)} className="cl-entry static">
                      {inner}
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** Dims the app round the control a change lives in, with a card saying what it is. */
function Spotlight({ entry }: { entry: ChangeEntry }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<'looking' | 'found' | 'missing'>('looking');
  const [rect, setRect] = useState<DOMRect | null>(null);
  const close = () => useChangelog.setState({ spot: null });

  useEffect(() => {
    let alive = true;
    setState('looking');
    setEl(null);
    revealTarget(entry.target!, () => alive).then((found) => {
      if (!alive) return;
      setEl(found);
      setState(found ? 'found' : 'missing');
      found?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => {
      alive = false;
    };
  }, [entry]);
  // follow the control as panes move, panels scroll and windows are dragged
  useEffect(() => {
    if (!el) return setRect(null);
    const find = () => setRect(el.isConnected && shown(el) ? el.getBoundingClientRect() : null);
    find();
    const id = setInterval(find, 150);
    return () => clearInterval(id);
  }, [el]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const pad = 4;
  const W = 300;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // the card sits beside the control where there is room, else below or above it
  let cardStyle: CSSProperties = { left: (vw - W) / 2, top: vh / 2 - 80 };
  if (rect) {
    const below = rect.bottom + 12;
    const top = below + 190 < vh ? below : Math.max(8, rect.top - 202);
    const right = rect.right + 12;
    cardStyle = right + W < vw && rect.height > 120 ? { left: right, top: Math.min(Math.max(8, rect.top), vh - 210) } : { left: Math.min(Math.max(8, rect.left), vw - W - 8), top };
  }
  return (
    <div className="spot" data-testid="changelog-spotlight" data-state={state}>
      {rect ? (
        <div className="spot-hole" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      ) : (
        <div className="spot-dim" />
      )}
      <div className="spot-card window" style={{ ...cardStyle, width: W }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Where: ${entry.title}`}>
        <div className="title-bar">
          <div className="title-bar-text">{entry.kind === 'new' ? 'New' : 'Fixed'}: {entry.title}</div>
          <div className="title-bar-controls">
            <button type="button" aria-label="Close" onClick={close} />
          </div>
        </div>
        <div className="window-body">
          <p className="spot-where">{entry.where}</p>
          {state === 'looking' && <p className="note">Finding it…</p>}
          {state === 'missing' && <p className="note">It isn't on screen right now; it shows there once that panel has something to work on.</p>}
          <div className="btnrow">
            <button className="btn sm" onClick={openChangelog}>
              ‹ Changelog
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn sm primary" onClick={close}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChangelogLayer() {
  const open = useChangelog((s) => s.open);
  const spot = useChangelog((s) => s.spot);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      closeChangelog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return (
    <>
      {open && <ChangelogWindow />}
      {spot?.target && <Spotlight entry={spot} />}
    </>
  );
}
