function asElement(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof target !== 'object') return null;
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) return target;
  const el = target as HTMLElement;
  return typeof el.tagName === 'string' ? el : null;
}

/** True when the event target is a field where `/` should type normally. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
  return false;
}

/** The Type a design instruction textarea (mod+k is left alone here). */
export function isDesignInstructionField(target: EventTarget | null): boolean {
  const el = asElement(target);
  return !!el?.closest?.('.design-box .design-input');
}

export type DesignShortcutAction = 'toggle';

export function designShortcutFromKey(
  key: string,
  modifiers: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  target: EventTarget | null,
): DesignShortcutAction | null {
  const mod = modifiers.ctrlKey || modifiers.metaKey;

  if (key === '/' && !mod && !modifiers.altKey && !modifiers.shiftKey) {
    if (isEditableTarget(target)) return null;
    return 'toggle';
  }

  if (key.toLowerCase() === 'k' && mod && !modifiers.altKey) {
    if (isDesignInstructionField(target)) return null;
    return 'toggle';
  }

  return null;
}
