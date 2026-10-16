/** Canonical colours (must match `src/styles.css` custom properties). */

export const CHROME = {
  bg: '#c0c0c0',
  fg: '#222222',
  muted: '#444444',
  listBg: '#000080',
  listFg: '#ffffff',
} as const;

/** Left/right Win98 side panels (Parameters, Inspector): always dark-on-silver, not --ink/--muted. */
export const PARAM_PANEL = {
  bg: CHROME.bg,
  fg: CHROME.fg,
  muted: CHROME.muted,
  disabled: '#4a4a4a',
  heading: CHROME.fg,
} as const;

export const THEME_SURFACES = {
  light: { ink: '#141414', panel: '#fbfaf7', panel2: '#f3f1ec', bg: '#efede8' },
  dark: { ink: '#ecebe6', panel: '#1c1c1a', panel2: '#232320', bg: '#141412' },
} as const;

export const FIELD = {
  bg: '#ffffff',
  fg: '#141414',
  placeholder: '#6a6862',
  disabledBg: '#dfdfdf',
  disabledFg: '#565656',
  readonlyFg: '#565656',
} as const;

export const FIELD_CSS_VAR_NAMES = [
  '--field-bg',
  '--field-fg',
  '--field-placeholder',
  '--field-disabled-bg',
  '--field-disabled-fg',
  '--field-readonly-fg',
] as const;

export const CHROME_CSS_VAR_NAMES = [
  '--chrome-bg',
  '--chrome-fg',
  '--chrome-muted',
  '--chrome-list-bg',
  '--chrome-list-fg',
] as const;

export const PARAM_PANEL_CSS_VAR_NAMES = [
  '--param-bg',
  '--param-fg',
  '--param-muted',
  '--param-disabled',
  '--param-heading',
] as const;

export const WCAG_AA_LARGE = 3;

export function fieldThemeTokens(): Record<string, string> {
  return {
    '--field-bg': FIELD.bg,
    '--field-fg': FIELD.fg,
    '--field-placeholder': FIELD.placeholder,
    '--field-disabled-bg': FIELD.disabledBg,
    '--field-disabled-fg': FIELD.disabledFg,
    '--field-readonly-fg': FIELD.readonlyFg,
  };
}

export function chromeThemeTokens(): Record<string, string> {
  return {
    '--chrome-bg': CHROME.bg,
    '--chrome-fg': CHROME.fg,
    '--chrome-muted': CHROME.muted,
    '--chrome-list-bg': CHROME.listBg,
    '--chrome-list-fg': CHROME.listFg,
  };
}

export function paramPanelThemeTokens(): Record<string, string> {
  return {
    '--param-bg': PARAM_PANEL.bg,
    '--param-fg': PARAM_PANEL.fg,
    '--param-muted': PARAM_PANEL.muted,
    '--param-disabled': PARAM_PANEL.disabled,
    '--param-heading': PARAM_PANEL.heading,
  };
}

export function pairedThemeTokens(): Record<string, string> {
  return { ...chromeThemeTokens(), ...paramPanelThemeTokens(), ...fieldThemeTokens() };
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channelLuminance(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA_NORMAL = 4.5;

export function meetsWcagAaNormal(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= WCAG_AA_NORMAL;
}
