// The shortcut sheet (press ?), and the changelog layer (Help › Changelog).
import { useEffect } from 'react';
import { create } from 'zustand';
import { TABS } from '../state/workspaces';
import ChangelogLayer, { openChangelog } from './Changelog';

const useHelp = create<{ sheet: boolean }>(() => ({ sheet: false }));
export const openShortcuts = () => useHelp.setState({ sheet: true });

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
      [['Ctrl', 'Space'], 'List the names a formula can use (ƒ box)'],
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
  {
    where: '3D view',
    keys: [
      [['N'], 'Show or hide the sidebar (Candles, Shelf, Objects, Materials, Move plates, Measure)'],
      [['M'], 'Measuring tape'],
    ],
  },
  {
    where: '3D view (view-only layers)',
    keys: [
      [['Alt', 'Shift', 'G'], 'Toggle grid'],
      [['Alt', 'Shift', 'P'], 'Toggle plates'],
      [['Alt', 'Shift', 'L'], 'Toggle labels / dimensions'],
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
      <div className="window pm help-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-testid="shortcuts-sheet">
        <div className="title-bar">
          <div className="title-bar-text">Keyboard shortcuts</div>
          <div className="title-bar-controls">
            <button type="button" aria-label="Close" onClick={close} />
          </div>
        </div>
        <div className="window-body help-sheet-body">
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
            <button
              className="btn primary"
              onClick={() => {
                useHelp.setState({ sheet: false });
                openChangelog();
              }}
            >
              Changelog
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The "?" in the status bar. */
export function HelpButton() {
  return (
    <button className="help-btn" onClick={openShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
      ?
    </button>
  );
}

export default function HelpLayer() {
  const sheet = useHelp((s) => s.sheet);
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
  return (
    <>
      {sheet && <ShortcutSheet />}
      <ChangelogLayer />
    </>
  );
}
