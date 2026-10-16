// The shortcut sheet (press ?) and a short one-time tour of the newer tools.
import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { useStore, type Tab } from '../state/store';
import { TABS } from '../state/workspaces';

const useHelp = create<{ sheet: boolean; tour: number | null }>(() => ({ sheet: false, tour: null }));
export const openShortcuts = () => useHelp.setState({ sheet: true });
export const startTour = () => useHelp.setState({ sheet: false, tour: 0 });

const TOUR_KEY = 'strata:tour-seen';
const tourSeen = () => {
  try {
    return localStorage.getItem(TOUR_KEY) === '1';
  } catch {
    return true; // no storage: don't pop the tour up on every visit
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(TOUR_KEY, '1');
  } catch {
    /* private window or blocked storage */
  }
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

/** Every keyboard shortcut the app has, by where it works. */
const SHORTCUTS: { where: string; keys: [string[], string][] }[] = [
  {
    where: 'Anywhere',
    keys: [
      [['?'], 'This sheet'],
      [['/'], 'Type a design (not while typing in a field)'],
      [[MOD, 'K'], 'Type a design (from parameter fields too; not in the instruction box)'],
      [[MOD, 'Z'], 'Undo'],
      [[MOD, 'Shift', 'Z'], 'Redo'],
      [[MOD, 'Y'], 'Redo'],
      ...TABS.slice(0, 8).map((t, i): [string[], string] => [[String(i + 1)], `${t.label} view`]),
      [['Esc'], 'Close a menu or dialog'],
    ],
  },
  {
    where: 'Parameters',
    keys: [
      [['Enter'], 'Apply a typed value'],
      [['↑', '↓'], 'Step a number (Shift: ×10)'],
      [['Esc'], 'Undo typing in an expression'],
    ],
  },
  {
    where: '3D view, Move plates on',
    keys: [
      [['W'], 'Move'],
      [['E'], 'Rotate'],
      [['Q'], 'World / local axes'],
      [['Esc'], 'Deselect'],
    ],
  },
  { where: 'Plates view', keys: [[['←', '→'], 'Previous / next plate (↑ ↓ too)']] },
  {
    where: 'Composer',
    keys: [
      [['←', '↑', '→', '↓'], 'Nudge the selected block (Shift: further)'],
      [[MOD, 'D'], 'Duplicate block'],
      [['Delete'], 'Remove block (Backspace too)'],
      [[MOD, 'Z'], 'Undo in the composer (Shift: redo)'],
      [['Esc'], 'Close (asks if not applied)'],
    ],
  },
  {
    where: 'Drawing pad',
    keys: [
      [[MOD, 'Z'], 'Undo stroke (Shift: redo)'],
      [['Esc'], 'Close'],
    ],
  },
];

function ShortcutSheet() {
  const close = () => useHelp.setState({ sheet: false });
  return (
    <div className="pm-back help-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pm help-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="box-head">
          <span>Keyboard shortcuts</span>
          <button className="btn sm" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="help-grid">
          {SHORTCUTS.map((g) => (
            <div className="help-group" key={g.where}>
              <div className="head">{g.where}</div>
              {g.keys.map(([keys, what], i) => (
                <div className="help-row" key={i}>
                  <span className="keys">
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  <span>{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="btnrow help-foot">
          <span className="note">Drop a picture, STL / OBJ or .strata.json anywhere on the window to load it.</span>
          <button className="btn primary" onClick={startTour}>
            Take the tour
          </button>
        </div>
      </div>
    </div>
  );
}

const byText = (sel: string, re: RegExp) => [...document.querySelectorAll<HTMLElement>(sel)].find((el) => re.test(el.textContent ?? '') && el.offsetParent !== null) ?? null;

const TOUR: { title: string; body: string; tab?: Tab; target: () => HTMLElement | null }[] = [
  {
    title: 'Composer',
    body: 'Image / Graphic › Composer places several pictures, patterns, drawings and sounds freely on a surface, and moves them between Top, Front and Side.',
    tab: 'image',
    target: () => byText('.main button', /^Composer$/),
  },
  {
    title: 'Depth from photo',
    body: 'Turns an ordinary photo into a relief: near things stand proud, the background stays uncut. Near, far and curve stay adjustable afterwards.',
    tab: 'image',
    target: () => byText('.main button', /^(Depth from photo|Reading depth)/),
  },
  {
    title: 'Plate materials',
    body: 'Appearance › Plate materials… sorts plates into buckets (Corten, aluminium…) by clicking them in the 3D view; the cut list and price follow.',
    target: () => byText('.topbar button', /^Appearance/),
  },
  {
    title: 'Workspaces',
    body: 'Arrange the views side by side. Drag any tab onto another pane, or onto an edge to split it; layouts are kept as you go.',
    target: () => document.querySelector<HTMLElement>('.ws-pick'),
  },
  {
    title: 'Shadow kitchen',
    body: 'Pictures that appear in the shadow at set times of day: the plates are carved so the sun draws each one on the wall.',
    target: () => byText('.ws-tabs [role="tab"]', /^Shadow$/),
  },
  {
    title: 'Sun study',
    body: 'Switch Sun on to set the place and date, then scrub the sun across the day in 3D. Press ? any time for shortcuts or to see this tour again.',
    target: () => document.querySelector<HTMLElement>('.left .section[data-group="Sun"]'),
  },
];

function Tour({ step }: { step: number }) {
  const s = TOUR[step];
  const [rect, setRect] = useState<DOMRect | null>(null);
  const finish = () => {
    markSeen();
    useHelp.setState({ tour: null });
  };
  const go = (n: number) => (n >= TOUR.length ? finish() : useHelp.setState({ tour: Math.max(0, n) }));

  useEffect(() => {
    if (s.tab) useStore.getState().setUi({ tab: s.tab });
    let first = true;
    // follow the target as panes move, panels scroll and views mount
    const find = () => {
      const el = s.target();
      if (el && first) {
        el.scrollIntoView({ block: 'center' });
        first = false;
      }
      setRect(el ? el.getBoundingClientRect() : null);
    };
    find();
    const id = setInterval(find, 200);
    return () => clearInterval(id);
  }, [s]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(step + 1);
      else if (e.key === 'ArrowLeft') go(step - 1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const pad = 4;
  const W = 300;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // the card sits beside the target where there is room, else below or above it
  let cardStyle: CSSProperties = { left: (vw - W) / 2, top: vh / 2 - 80 };
  if (rect) {
    const below = rect.bottom + 12;
    const top = below + 210 < vh ? below : Math.max(8, rect.top - 222);
    const right = rect.right + 12;
    cardStyle = right + W < vw && rect.height > 120 ? { left: right, top: Math.min(Math.max(8, rect.top), vh - 230) } : { left: Math.min(Math.max(8, rect.left), vw - W - 8), top };
  }
  return (
    <div className="tour" role="dialog" aria-label={`Tour: ${s.title}`}>
      {rect ? (
        <div className="tour-hole" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" style={{ ...cardStyle, width: W }}>
        <div className="tour-step">
          {step + 1} / {TOUR.length} · new tools
        </div>
        <div className="tour-title">{s.title}</div>
        <p>{s.body}</p>
        <div className="btnrow">
          <button className="btn sm" onClick={finish}>
            Skip
          </button>
          <span style={{ flex: 1 }} />
          {step > 0 && (
            <button className="btn sm" onClick={() => go(step - 1)}>
              Back
            </button>
          )}
          <button className="btn sm primary" onClick={() => go(step + 1)}>
            {step === TOUR.length - 1 ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "?" in the status bar. */
export function HelpButton() {
  return (
    <button className="help-btn" onClick={openShortcuts} title="Keyboard shortcuts and a tour (?)" aria-label="Keyboard shortcuts">
      ?
    </button>
  );
}

export default function HelpLayer() {
  const sheet = useHelp((s) => s.sheet);
  const tour = useHelp((s) => s.tour);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        useHelp.setState((s) => ({ sheet: !s.sheet }));
      } else if (e.key === 'Escape' && useHelp.getState().sheet) useHelp.setState({ sheet: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // once, on a first visit, after the app has settled
  useLayoutEffect(() => {
    if (tourSeen()) return;
    const id = setTimeout(() => {
      if (!document.querySelector('.pm-back') && useHelp.getState().tour === null) startTour();
    }, 1500);
    return () => clearTimeout(id);
  }, []);
  return (
    <>
      {sheet && <ShortcutSheet />}
      {tour !== null && <Tour step={tour} />}
    </>
  );
}
