import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';

/**
 * One 98.css tab: `menu[role=tablist] > li[role=tab] > a`. The `li` is the tab itself
 * (focusable, keyboard-driven) and the `a` has no href, so screen readers don't hear a
 * link nested inside a tab. Arrow keys / Home / End move between tabs and select them.
 */
export function Tab({
  selected,
  onSelect,
  onKeyDown,
  children,
  after,
  ...rest
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  /** Drawn after the label, inside the tab (e.g. a mouse-only close button). */
  after?: ReactNode;
} & Omit<HTMLAttributes<HTMLLIElement>, 'onSelect'>) {
  const keys = (e: KeyboardEvent<HTMLLIElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
      return;
    }
    const tabs = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(':scope > [role="tab"]') ?? [])];
    const i = tabs.indexOf(e.currentTarget);
    const to =
      e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length]
      : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === 'Home' ? tabs[0]
      : e.key === 'End' ? tabs[tabs.length - 1]
      : undefined;
    if (!to) return;
    e.preventDefault();
    to.focus();
    to.click();
  };
  return (
    <li {...rest} role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={onSelect} onKeyDown={keys}>
      <a>{children}</a>
      {after}
    </li>
  );
}
