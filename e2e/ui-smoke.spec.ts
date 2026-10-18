import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp } from './map-helpers';
import { TABS } from '../src/state/workspaces';

// Click-through of the main UI: catches panels or views that throw, menus that no longer
// open, and parameter groups that stop folding after a refactor.

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const tab = (page: Page, name: string) => page.locator('.ws-tabs').getByRole('tab', { name, exact: true }).first();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('every workspace tab opens and draws its view', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openApp(page);
  for (const t of TABS) {
    await tab(page, t.label).click();
    await expect(tab(page, t.label)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ws-pane .view').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('every parameter group folds and unfolds', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openApp(page);
  // park the 3D view: headless software WebGL draws ~2 frames/s, which makes every click slow
  await tab(page, 'Graph').click();
  const heads = page.locator('.left.window fieldset.section button.section-head');
  const n = await heads.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) {
    const head = heads.nth(i);
    const was = await head.getAttribute('aria-expanded');
    const flipped = was === 'true' ? 'false' : 'true';
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', flipped);
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', was ?? 'false');
  }
  expect(errors).toEqual([]);
});

test('toolbar menus open, pass an accessibility check and close on Escape', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openApp(page);
  for (const name of ['Appearance', 'Presets', 'Maps', 'Shuffle', 'Import']) {
    const btn = page.locator('.topbar .menu > button', { hasText: new RegExp(`^${name}\\b`) }).first();
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    const pop = page.locator('.menu-pop').first();
    await expect(pop).toBeVisible();
    const r = await new AxeBuilder({ page }).include('.menu-pop').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(r.violations.map((v) => `${name}: ${v.id} ${v.nodes.map((x) => x.target.join(' ')).join(', ')}`)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
  }
  expect(errors).toEqual([]);
});

test('picking a preset rebuilds the plates without errors', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openApp(page);
  await page.locator('.topbar .menu > button', { hasText: /^Presets\b/ }).first().click();
  const items = page.locator('.menu-pop .tree-view button');
  expect(await items.count()).toBeGreaterThan(1);
  await items.nth(1).click();
  await tab(page, 'Plates').click();
  await expect(page.locator('.tbl.interactive')).toBeVisible({ timeout: 30_000 });
  expect(await page.locator('.tbl.interactive tbody tr').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
