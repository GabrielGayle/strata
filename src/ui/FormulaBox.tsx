import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formulaVars, insertVar, matchVars, wordAt, type FormulaVar } from '../core/formulaVars';
import type { ParamDef } from '../core/params';
import { useModel } from './model';

function fmtNum(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return '';
  return String(+x.toFixed(Math.abs(x) >= 100 ? 1 : 3));
}

/**
 * A parameter's formula box, with a list of everything the formula can use: typing a
 * name filters it (autocomplete), and ▾ shows the lot. Clicking an entry or pressing
 * Enter / Tab puts it in at the caret.
 */
export default function FormulaBox({
  def,
  text,
  error,
  openSignal,
  onFocus,
  onEdit,
  onCommit,
  onRevert,
}: {
  def: ParamDef;
  text: string;
  error?: string;
  /** Bumped to open the list and focus the box (the ƒ button). */
  openSignal: number;
  onFocus: () => void;
  onEdit: (t: string) => void;
  onCommit: (t: string) => void;
  onRevert: () => void;
}) {
  const model = useModel();
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const listId = `fx-list-${def.id}`;

  const vars = useMemo(
    () => (open ? formulaVars(def.id, model.v, model.ev.flags, model.ev.deps) : []),
    [open, def.id, model.v, model.ev.flags, model.ev.deps],
  );
  const shown = useMemo(() => matchVars(vars, word), [vars, word]);
  const pickable = useMemo(() => shown.filter((v) => !v.blocked), [shown]);
  const current = pickable[Math.min(active, pickable.length - 1)];

  const place = () => {
    const r = input.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(Math.max(r.width + 60, 320), window.innerWidth - 8);
    const left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4));
    const below = window.innerHeight - r.bottom - 6;
    const above = r.top - 6;
    const up = below < 180 && above > below;
    setPos({ left, top: up ? r.top - 2 : r.bottom + 2, width, maxHeight: Math.min(280, up ? above : below), up });
  };

  const refresh = (t: string, caret: number, force = false) => {
    const w = wordAt(t, caret).word;
    setWord(w);
    setActive(0);
    if (w || force) {
      place();
      setOpen(true);
    } else setOpen(false);
  };

  useEffect(() => {
    if (!openSignal) return;
    const el = input.current;
    if (!el) return;
    el.focus();
    const c = el.value.length;
    el.setSelectionRange(c, c);
    refresh(el.value, c, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  // follow the box when the panel scrolls or the window resizes
  useEffect(() => {
    if (!open) return;
    const on = () => place();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !current) return;
    document.getElementById(`${listId}-${current.name}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, current, listId]);

  const pick = (v: FormulaVar) => {
    const el = input.current;
    if (!el || v.blocked) return;
    const r = insertVar(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, v);
    onEdit(r.text);
    setOpen(false);
    setWord('');
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  // headings between groups, only for groups that have something to show
  const rows: ({ head: string } | FormulaVar)[] = [];
  let last = '';
  for (const v of shown) {
    if (v.group !== last) rows.push({ head: (last = v.group) });
    rows.push(v);
  }

  return (
    <>
      <input
        ref={input}
        className={`exprbox ${error ? 'err' : ''}`}
        value={text}
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && current ? `${listId}-${current.name}` : undefined}
        onFocus={onFocus}
        onChange={(e) => {
          onEdit(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onBlur={(e) => {
          setOpen(false);
          onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (open && pickable.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = pickable.length;
              setActive((a) => (Math.min(a, n - 1) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && current) {
              e.preventDefault();
              pick(current);
              return;
            }
          }
          if (e.key === 'Escape') {
            if (open) {
              setOpen(false);
              return;
            }
            onRevert();
          }
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === ' ' && e.ctrlKey) {
            e.preventDefault();
            const el = e.target as HTMLInputElement;
            refresh(el.value, el.selectionStart ?? el.value.length, true);
          }
        }}
        aria-label={`${def.label} expression`}
      />
      <button
        type="button"
        className={`ibtn fx-open ${open ? 'on' : ''}`}
        data-hl="formula-vars"
        title="Names you can use in this formula (or start typing one; Ctrl+Space)"
        aria-label={`Names for ${def.label}'s formula`}
        aria-expanded={open}
        // keep the caret in the box so the pick lands where you were typing
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const el = input.current;
          if (!el) return;
          if (open) return setOpen(false);
          if (document.activeElement !== el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
          refresh(el.value, el.selectionStart ?? el.value.length, true);
        }}
      >
        ▾
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            className="fx-menu"
            id={listId}
            role="listbox"
            aria-label={`Names for ${def.label}'s formula`}
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {!shown.length && <div className="fx-none">Nothing called “{word}”</div>}
            {rows.map((r) =>
              'head' in r ? (
                <div key={`h:${r.head}`} className="fx-head" role="presentation">
                  {r.head}
                </div>
              ) : (
                <div
                  key={r.name}
                  id={`${listId}-${r.name}`}
                  role="option"
                  aria-selected={r === current}
                  aria-disabled={r.blocked ? true : undefined}
                  className={`fx-row ${r === current ? 'on' : ''} ${r.blocked ? 'blocked' : ''}`}
                  title={r.blocked ?? (r.kind === 'func' ? r.label : `${r.label} (${r.name})`)}
                  onMouseEnter={() => {
                    const i = pickable.indexOf(r);
                    if (i >= 0) setActive(i);
                  }}
                  onClick={() => pick(r)}
                >
                  <span className="fx-name">{r.kind === 'func' ? `${r.name}()` : r.name}</span>
                  <span className="fx-label">{r.kind === 'func' ? r.label.replace(/^[^:]*:\s*/, '') : r.label}</span>
                  <span className="fx-val">
                    {fmtNum(r.value)}
                    {r.value !== undefined && r.unit ? ` ${r.unit}` : ''}
                  </span>
                </div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
