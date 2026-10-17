import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openApp, setThemePreset, waitForThemeMode } from './map-helpers';

const shotDir = join(process.cwd(), 'docs/screenshots/shortcuts');

const THEMES = [
  { name: 'Paper', mode: 'light' as const, file: 'paper.png' },
  { name: 'Dusk', mode: 'dark' as const, file: 'dusk.png' },
  { name: 'Ink', mode: 'dark' as const, file: 'ink.png' },
];

function cssAlpha(bg: string): number {
  const s = bg.trim().toLowerCase();
  if (!s || s === 'transparent') return 0;
  const m = s.match(/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) return m[1] === undefined ? 1 : Number(m[1]);
  return 1;
}

async function openShortcutsSheet(page: Page) {
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const sheet = page.getByTestId('shortcuts-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

test('shortcuts sheet has a solid 98.css window background in Paper, Dusk and Ink', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await mkdir(shotDir, { recursive: true });

  for (const theme of THEMES) {
    await setThemePreset(page, theme.name);
    await waitForThemeMode(page, theme.mode);
    const sheet = await openShortcutsSheet(page);
    const bg = await sheet.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `${theme.name} background must not be transparent`).not.toMatch(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/);
    expect(cssAlpha(bg), `${theme.name} computed background ${bg}`).toBeGreaterThan(0.9);
    await sheet.screenshot({ path: join(shotDir, theme.file) });
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
});
