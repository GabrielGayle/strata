import { describe, expect, it } from 'vitest';
import { designShortcutFromKey, isEditableTarget } from '../src/ui/designShortcut';

function el(tag: string, extra: Record<string, unknown> = {}): EventTarget {
  return { tagName: tag.toUpperCase(), isContentEditable: false, closest: () => null, ...extra } as unknown as EventTarget;
}

describe('design shortcuts', () => {
  const none = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  it('isEditableTarget covers input, textarea, select, and contenteditable', () => {
    expect(isEditableTarget(el('input'))).toBe(true);
    expect(isEditableTarget(el('textarea'))).toBe(true);
    expect(isEditableTarget(el('select'))).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true, closest: () => null } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(el('div'))).toBe(false);
  });

  it('slash toggles only outside editable fields', () => {
    expect(designShortcutFromKey('/', none, el('input'))).toBeNull();
    expect(designShortcutFromKey('/', none, el('div'))).toBe('toggle');
    expect(designShortcutFromKey('/', { ...none, shiftKey: true }, el('div'))).toBeNull();
    expect(designShortcutFromKey('/', { ...none, ctrlKey: true }, el('div'))).toBeNull();
  });

  it('mod+k toggles from parameter inputs but not the design instruction field', () => {
    const mod = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(designShortcutFromKey('k', mod, el('input'))).toBe('toggle');

    const instruction = el('textarea', {
      className: 'design-input',
      closest: (sel: string) => (sel === '.design-box .design-input' ? instruction : null),
    });
    expect(designShortcutFromKey('k', mod, instruction)).toBeNull();
  });
});
