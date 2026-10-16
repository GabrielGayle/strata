import { useEffect, useMemo, useRef, useState } from 'react';
import { diffProjectPatch, parseDesign, loadDesignHistory, pushDesignHistory, type Span } from '../core/design';
import { useStore } from '../state/store';

function highlight(text: string, matched: Span[], unrecognised: Span[]) {
  const marks: { start: number; end: number; kind: 'ok' | 'bad' }[] = [
    ...matched.map((s) => ({ ...s, kind: 'ok' as const })),
    ...unrecognised.map((s) => ({ ...s, kind: 'bad' as const })),
  ].sort((a, b) => a.start - b.start);
  const parts: { t: string; kind?: 'ok' | 'bad' }[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start > pos) parts.push({ t: text.slice(pos, m.start) });
    parts.push({ t: text.slice(m.start, m.end), kind: m.kind });
    pos = m.end;
  }
  if (pos < text.length) parts.push({ t: text.slice(pos) });
  return parts;
}

export default function DesignBox({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const activeSetup = useStore((s) => s.activeSetup);
  const applyDesignPatch = useStore((s) => s.applyDesignPatch);
  const undo = useStore((s) => s.undo);
  const [text, setText] = useState('');
  const [history, setHistory] = useState(() => loadDesignHistory(activeSetup));
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parsed = useMemo(() => parseDesign(text, { project }), [text, project]);
  const preview = useMemo(() => diffProjectPatch(project, parsed.patch), [project, parsed.patch]);
  const parts = useMemo(() => highlight(text, parsed.matched, parsed.unrecognised), [text, parsed]);

  const apply = () => {
    const t = text.trim();
    if (!t) return;
    applyDesignPatch(parsed.patch, `design: ${t.slice(0, 40)}`);
    setHistory(pushDesignHistory(activeSetup, t));
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="pm-back" onClick={onClose}>
      <div
        className="window design-box"
        role="dialog"
        aria-modal="true"
        aria-label="Type a design"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="title-bar">
          <div className="title-bar-text">Type a design</div>
          <div className="title-bar-controls">
            <button type="button" aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body design-box-body">
          <p className="design-hint">
            Plain language edits the same parameters as the CLI <span className="mono">say</span> command. Press{' '}
            <kbd>/</kbd> (outside text fields) or <kbd>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>+<kbd>K</kbd> to
            open this panel from anywhere except while the cursor is in the instruction box below.
          </p>
          <textarea
            ref={inputRef}
            className="design-input"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="40 plates, 3mm steel, A4 landscape…"
            spellCheck={false}
          />
          <div className="design-highlight" aria-live="polite">
            {parts.map((p, i) =>
              p.kind ? (
                <mark key={i} className={p.kind === 'bad' ? 'design-unrec' : 'design-match'}>{p.t}</mark>
              ) : (
                <span key={i}>{p.t}</span>
              ),
            )}
          </div>
          <fieldset className="design-diff">
            <legend>Preview</legend>
            {preview.preset && <div className="mono">preset → {preview.preset}</div>}
            {preview.name && <div className="mono">name → {preview.name}</div>}
            {preview.changes.length === 0 && !preview.preset && !preview.name ? (
              <p className="muted">No parameter changes yet.</p>
            ) : (
              <ul className="design-diff-list">
                {preview.changes.map((c) => (
                  <li key={c.id} className="mono">
                    <span className="design-param">{c.id}</span> {c.before} → {c.after}
                  </li>
                ))}
              </ul>
            )}
            {parsed.unrecognised.length > 0 && (
              <p className="design-warn">Unrecognised: {parsed.unrecognised.map((s) => text.slice(s.start, s.end)).join('; ')}</p>
            )}
          </fieldset>
          {history.length > 0 && (
            <fieldset className="design-history">
              <legend>History</legend>
              <ul>
                {history.map((h) => (
                  <li key={h.at}>
                    <button type="button" className="btn sm" onClick={() => setText(h.text)} title={h.at}>
                      {h.text.length > 60 ? `${h.text.slice(0, 57)}…` : h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <div className="design-actions">
            <button type="button" className="btn" onClick={undo}>Undo last</button>
            <button type="button" className="btn primary" onClick={apply} disabled={!text.trim()}>
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
