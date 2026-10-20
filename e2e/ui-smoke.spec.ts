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

test('the candelabra picker adds candles in the docked sidebar, which shrinks the 3D view and passes an accessibility check', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await openApp(page);
  await tab(page, '3D').click();
  const main = page.locator('.vp-main');
  await expect(main.locator('canvas')).toBeVisible({ timeout: 120_000 });
  const full = (await main.boundingBox())!.width;
  await page.getByTestId('sidebar-tab-candles').click();
  const win = page.locator('.vp-sidebar .objects');
  await page.getByRole('button', { name: '+ Candelabra' }).click();
  await expect(page.getByTestId('candle-row')).toHaveCount(2);
  await page.getByTestId('candle-add-maxi').click();
  await page.getByTestId('candle-add-taper').click();
  await expect(page.getByTestId('candle-row')).toHaveCount(3);
  await expect(page.getByTestId('candle-row').first().locator('output')).toHaveText('6');
  await win.getByRole('button', { name: 'Remove Maxi tealight' }).click();
  await expect(page.getByTestId('candle-row')).toHaveCount(2);

  const r = await new AxeBuilder({ page }).include('.vp-sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).disableRules(['target-size']).analyze();
  expect(r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);

  // docked, not floating: the 3D view gets narrower by the sidebar's width
  const side = (await page.locator('.vp-sidebar').boundingBox())!;
  const view = (await main.boundingBox())!;
  expect(Math.round(view.x + view.width)).toBeLessThanOrEqual(Math.round(side.x) + 1);
  expect(view.width).toBeLessThan(full - 200);

  // the left edge drags it wider
  const edge = (await page.locator('.vs-edge').boundingBox())!;
  await page.mouse.move(edge.x + 3, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 97, edge.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await page.locator('.vp-sidebar').boundingBox())!.width - side.width)).toBe(100);

  // a panel folds away, and N shuts and reopens the sidebar on the same tab
  await page.getByRole('button', { name: 'Candelabra', exact: true }).click();
  await expect(page.getByTestId('candle-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Candelabra', exact: true }).click();
  await page.locator('.vp-main canvas').hover();
  await page.keyboard.press('n');
  await expect(win).toHaveCount(0);
  expect((await main.boundingBox())!.width).toBeGreaterThan(full - 40);
  await page.keyboard.press('n');
  await expect(page.getByTestId('candle-row')).toHaveCount(2);
  expect(errors).toEqual([]);
});
