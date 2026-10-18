import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, setThemePreset, waitForThemeMode } from './map-helpers';
import { TABS } from '../src/state/workspaces';

// WCAG 2.2 A + AA, checked by axe in the real app. `target-size` (24px targets) is left
// out on purpose: the 18px Win98 icon buttons beside each parameter are the 98.css look.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SKIP = ['target-size'];

async function violations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).disableRules(SKIP).analyze();
  return r.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(' ')} :: ${(n.any[0]?.message ?? n.failureSummary ?? '').replace(/\s+/g, ' ')}`),
  );
}

for (const [theme, mode] of [['Paper', 'light'], ['Dusk', 'dark'], ['Ink', 'dark']] as const) {
  test(`every workspace tab passes WCAG AA in ${theme}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await setThemePreset(page, theme);
    await waitForThemeMode(page, mode);
    const found: string[] = [];
    for (const t of TABS) {
      await page.locator('.ws-tabs').getByRole('tab', { name: t.label, exact: true }).first().click();
      await page.waitForTimeout(800);
      for (const v of await violations(page)) found.push(`[${t.label}] ${v}`);
    }
    expect([...new Set(found)]).toEqual([]);
  });
}

test('workspace tabs work from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.locator('.ws-tabs').getByRole('tab', { name: '3D', exact: true }).first().click();
  const strip = page.locator('.ws-tabs').first();
  const first = strip.getByRole('tab', { name: '3D' });
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const second = strip.getByRole('tab', { name: 'Plates' });
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  // only the selected tab is in the Tab order
  await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
});
