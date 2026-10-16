// Window appearance: palettes generated from a few seeds (hue, saturation,
// light/dark, accent) and applied as CSS custom properties on :root.

import { chromeThemeTokens, fieldThemeTokens } from './fieldContrast';

export interface ThemeSeed {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  hue: number; // 0..360, tint of the surfaces
  sat: number; // 0..1, how coloured the surfaces are
  accent: string; // hex
  etch?: string; // hex, colour of etch / info lines
}

/** "system" follows the stylesheet's own light/dark tokens. */
export type ThemeChoice = { id: 'system' } | ThemeSeed;

export const THEME_PRESETS: ThemeSeed[] = [
  { id: 'paper', name: 'Paper', mode: 'light', hue: 40, sat: 0.18, accent: '#d4521c' },
  { id: 'sky', name: 'Sky', mode: 'light', hue: 208, sat: 0.55, accent: '#2f6fd6', etch: '#2f6fd6' },
  { id: 'powder', name: 'Powder blue', mode: 'light', hue: 214, sat: 0.32, accent: '#c4547d', etch: '#3e6db5' },
  { id: 'glacier', name: 'Glacier', mode: 'light', hue: 192, sat: 0.42, accent: '#1f8a9e', etch: '#2b6e9e' },
  { id: 'mauve', name: 'Mauve', mode: 'light', hue: 300, sat: 0.28, accent: '#8e4f9e', etch: '#6a5bb5' },
  { id: 'lavender', name: 'Lavender', mode: 'light', hue: 262, sat: 0.42, accent: '#6a4fc4', etch: '#5b62c4' },
  { id: 'heather', name: 'Heather', mode: 'light', hue: 325, sat: 0.22, accent: '#3f6fb8', etch: '#9a4f86' },
  { id: 'lilac-sky', name: 'Lilac sky', mode: 'light', hue: 245, sat: 0.38, accent: '#c45ca8', etch: '#4d6fd0' },
  { id: 'ink', name: 'Ink', mode: 'dark', hue: 45, sat: 0.06, accent: '#ff6a2e' },
  { id: 'dusk', name: 'Dusk', mode: 'dark', hue: 270, sat: 0.22, accent: '#d89be8', etch: '#9fb4ff' },
  { id: 'night-sky', name: 'Night sky', mode: 'dark', hue: 215, sat: 0.3, accent: '#7fb2ff', etch: '#9ad0ff' },
];

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360} ${Math.round(clamp(s) * 100)}% ${Math.round(clamp(l) * 1000) / 10}%)`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('');
}

/** Every UI token for a seed. */
export function themeTokens(t: ThemeSeed): Record<string, string> {
  const { hue: h, sat: s, accent } = t;
  const etch = t.etch ?? (t.mode === 'light' ? '#2f5f9e' : '#79a7e6');
  const accentInk = luminance(accent) > 0.45 ? '#141414' : '#ffffff';
  const paired = { ...chromeThemeTokens(), ...fieldThemeTokens() };
  if (t.mode === 'light') {
    return {
      ...paired,
      '--bg': hsl(h, s * 0.7, 0.91),
      '--panel': hsl(h, s * 0.65, 0.966),
      '--panel-2': hsl(h, s * 0.7, 0.932),
      '--ink': hsl(h, s * 0.45, 0.13),
      '--muted': hsl(h, s * 0.2, 0.42),
      '--line': hsl(h, s * 0.45, 0.16),
      '--line-soft': hsl(h, s * 0.35, 0.8),
      '--accent': accent,
      '--accent-ink': accentInk,
      '--sel': mixHex(accent, '#ffffff', 0.82),
      '--viewport': hsl(h, s * 0.6, 0.88),
      '--grid-a': hsl(h, s * 0.4, 0.79),
      '--grid-b': hsl(h, s * 0.4, 0.63),
      '--svg-fill': hsl(h, s * 0.45, 0.87),
      '--svg-cut': hsl(h, s * 0.45, 0.13),
      '--svg-etch': etch,
      '--info': etch,
      'color-scheme': 'light',
    };
  }
  return {
    ...paired,
    '--bg': hsl(h, s * 0.6, 0.075),
    '--panel': hsl(h, s * 0.55, 0.105),
    '--panel-2': hsl(h, s * 0.55, 0.135),
    '--ink': hsl(h, s * 0.3, 0.92),
    '--muted': hsl(h, s * 0.2, 0.62),
    '--line': hsl(h, s * 0.3, 0.88),
    '--line-soft': hsl(h, s * 0.35, 0.27),
    '--accent': accent,
    '--accent-ink': accentInk,
    '--sel': mixHex(accent, '#000000', 0.62),
    '--viewport': hsl(h, s * 0.5, 0.12),
    '--grid-a': hsl(h, s * 0.35, 0.21),
    '--grid-b': hsl(h, s * 0.35, 0.33),
    '--svg-fill': hsl(h, s * 0.4, 0.17),
    '--svg-cut': hsl(h, s * 0.3, 0.92),
    '--svg-etch': etch,
    '--info': etch,
    'color-scheme': 'dark',
  };
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  const keys = Object.keys(themeTokens(THEME_PRESETS[0]));
  for (const k of keys) root.style.removeProperty(k);
  root.removeAttribute('data-theme');
  if (choice.id === 'system') return;
  const tokens = themeTokens(choice as ThemeSeed);
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  root.setAttribute('data-theme', (choice as ThemeSeed).mode);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

/** A random but harmonious palette; light unless asked for dark. */
export function randomTheme(mode: 'light' | 'dark' = 'light', family?: 'blue' | 'mauve'): ThemeSeed {
  const r = Math.random;
  let hue: number;
  if (family === 'blue') hue = 190 + r() * 40;
  else if (family === 'mauve') hue = 255 + r() * 75;
  else hue = r() * 360;
  const sat = mode === 'light' ? 0.18 + r() * 0.42 : 0.1 + r() * 0.3;
  // accent: analogous or complementary, saturated enough to read on the surfaces
  const offs = [0, 30, -30, 150, 180, 210][Math.floor(r() * 6)];
  const ah = (hue + offs + 360) % 360;
  const accent = mode === 'light' ? hslToHex(ah, 0.55 + r() * 0.25, 0.42 + r() * 0.1) : hslToHex(ah, 0.6 + r() * 0.3, 0.66 + r() * 0.1);
  const etch = mode === 'light' ? hslToHex((hue + 20) % 360, 0.5, 0.42) : hslToHex((hue + 20) % 360, 0.6, 0.72);
  return { id: `random-${Date.now().toString(36)}`, name: 'Random', mode, hue: Math.round(hue), sat: Math.round(sat * 100) / 100, accent, etch };
}

const KEY = 'strata.theme.v1';
export function loadTheme(): ThemeChoice {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const t = JSON.parse(s);
      if (t && (t.id === 'system' || (typeof t.hue === 'number' && typeof t.accent === 'string'))) return t;
    }
  } catch {
    /* storage unavailable */
  }
  return { id: 'system' };
}
export function saveTheme(t: ThemeChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}
