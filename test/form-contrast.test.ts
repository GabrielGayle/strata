import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHROME,
  CHROME_CSS_VAR_NAMES,
  FIELD,
  FIELD_CSS_VAR_NAMES,
  PARAM_PANEL,
  PARAM_PANEL_CSS_VAR_NAMES,
  THEME_SURFACES,
  WCAG_AA_LARGE,
  WCAG_AA_NORMAL,
  contrastRatio,
  mapTabLabelContrast,
  meetsWcagAaNormal,
} from '../src/ui/fieldContrast';

const STYLES = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
const FORM_CHROME = readFileSync(resolve(import.meta.dirname, '../src/form-chrome.css'), 'utf8');

function blockVars(css: string, selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`, 's');
  const m = re.exec(css);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(';')) {
    const p = line.trim().match(/^(--[\w-]+)\s*:\s*(.+)$/);
    if (p) out[p[1]] = p[2].trim();
  }
  return out;
}

describe('form + chrome contrast (WCAG AA)', () => {
  it('field text and placeholders meet 4.5:1 on field background', () => {
    expect(meetsWcagAaNormal(FIELD.fg, FIELD.bg)).toBe(true);
    expect(meetsWcagAaNormal(FIELD.placeholder, FIELD.bg)).toBe(true);
    expect(meetsWcagAaNormal(FIELD.disabledFg, FIELD.disabledBg)).toBe(true);
    expect(meetsWcagAaNormal(FIELD.readonlyFg, FIELD.disabledBg)).toBe(true);
    expect(contrastRatio(FIELD.fg, FIELD.bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it('win98 chrome and list selection meet 4.5:1', () => {
    expect(meetsWcagAaNormal(CHROME.fg, CHROME.bg)).toBe(true);
    expect(meetsWcagAaNormal(CHROME.muted, CHROME.bg)).toBe(true);
    expect(meetsWcagAaNormal(CHROME.listFg, CHROME.listBg)).toBe(true);
  });

  it('parameters panel text tokens meet WCAG on silver panel (all themes)', () => {
    expect(meetsWcagAaNormal(PARAM_PANEL.fg, PARAM_PANEL.bg)).toBe(true);
    expect(meetsWcagAaNormal(PARAM_PANEL.muted, PARAM_PANEL.bg)).toBe(true);
    expect(meetsWcagAaNormal(PARAM_PANEL.disabled, PARAM_PANEL.bg)).toBe(true);
    expect(contrastRatio(PARAM_PANEL.heading, PARAM_PANEL.bg)).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
  });

  it('themed ink on panel surfaces meet 4.5:1 in light and dark', () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = THEME_SURFACES[mode];
      expect(meetsWcagAaNormal(t.ink, t.panel)).toBe(true);
      expect(meetsWcagAaNormal(t.ink, t.panel2)).toBe(true);
      expect(meetsWcagAaNormal(t.ink, t.bg)).toBe(true);
    }
  });

  it('styles.css :root tokens match canonical field + chrome constants', () => {
    const root = blockVars(STYLES, ':root');
    expect(root['--field-bg']).toBe(FIELD.bg);
    expect(root['--field-fg']).toBe(FIELD.fg);
    expect(root['--field-placeholder']).toBe(FIELD.placeholder);
    expect(root['--field-disabled-bg']).toBe(FIELD.disabledBg);
    expect(root['--field-disabled-fg']).toBe(FIELD.disabledFg);
    expect(root['--field-readonly-fg']).toBe(FIELD.readonlyFg);
    expect(root['--chrome-fg']).toBe(CHROME.fg);
    expect(root['--chrome-bg']).toBe(CHROME.bg);
    expect(root['--chrome-muted']).toBe(CHROME.muted);
    expect(root['--chrome-list-bg']).toBe(CHROME.listBg);
    expect(root['--chrome-list-fg']).toBe(CHROME.listFg);
    expect(root['--param-fg']).toBe(PARAM_PANEL.fg);
    expect(root['--param-muted']).toBe(PARAM_PANEL.muted);
    for (const name of [...FIELD_CSS_VAR_NAMES, ...CHROME_CSS_VAR_NAMES, ...PARAM_PANEL_CSS_VAR_NAMES]) {
      expect(root[name], name).toBeTruthy();
    }
  });

  it('dark theme blocks keep win98 field + chrome tokens (not --ink on fields)', () => {
    const dark = blockVars(STYLES, ":root[data-theme='dark']");
    expect(dark['--field-fg']).toBe(FIELD.fg);
    expect(dark['--field-bg']).toBe(FIELD.bg);
    expect(dark['--chrome-fg']).toBe(CHROME.fg);
    expect(dark['--param-fg']).toBe(PARAM_PANEL.fg);
    expect(dark['--param-muted']).toBe(PARAM_PANEL.muted);
    expect(dark['--ink']).toBe(THEME_SURFACES.dark.ink);
  });

  it('map tab labels, fieldset legends, and notes meet contrast on themed panels', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { fg, panel, panel2 } = mapTabLabelContrast(mode);
      expect(meetsWcagAaNormal(fg, panel)).toBe(true);
      expect(meetsWcagAaNormal(fg, panel2)).toBe(true);
      const muted = mode === 'light' ? '#6a6862' : '#9b998f';
      expect(meetsWcagAaNormal(muted, panel2)).toBe(true);
    }
    expect(meetsWcagAaNormal(CHROME.fg, THEME_SURFACES.dark.panel2)).toBe(false);
    expect(FORM_CHROME).toContain('.map-view :is(fieldset, legend, label, h2, h3)');
  });

  it('map tab disabled controls keep field disabled tokens (not grey-on-grey)', () => {
    expect(meetsWcagAaNormal(FIELD.disabledFg, FIELD.disabledBg)).toBe(true);
    expect(FORM_CHROME).toContain('.map-view button:disabled');
  });
});
