import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openApp,
  openWorkspaceTab,
  pickNeasdenPreset,
  assertMapPreviewNonUniform,
  assertPlateHeightMatchesRelief,
  setThemePreset,
  waitForViewportRelief,
  waitForThemeMode,
  waitForPlatesView,
  waitForMapReady,
} from './map-helpers';

async function assertNoThin2mmWarnings(page: import('@playwright/test').Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  await expect(page.locator('.issue').filter({ hasText: /narrower than 2 mm/ })).toHaveCount(0);
}

async function assertZeroFitErrors(page: import('@playwright/test').Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  await expect(page.locator('.status-bar-field').filter({ hasText: /errors/ })).toHaveText('0 errors');
}

test('neasden map plates follow real elevation × exaggeration (fixture)', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);

  const partsText = await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await assertPlateHeightMatchesRelief(page, 0.3);
  await assertNoThin2mmWarnings(page);
  await assertZeroFitErrors(page);
  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-view h2')).toBeVisible();
  const dtm = page.locator('#map-model-dtm');
  await expect(dtm).toBeChecked();
  await expect.poll(async () => dtm.evaluate((el) => el.nextElementSibling?.getAttribute('for'))).toBe('map-model-dtm');
  await expect(page.locator('label[for="map-model-dtm"]')).toBeVisible();
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  await assertMapPreviewNonUniform(page);

  await mkdir(join(process.cwd(), 'docs/screenshots'), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), 'docs/screenshots/neasden-map-3d.png'), fullPage: false });
  await page.locator('.map-view').screenshot({ path: join(process.cwd(), 'docs/screenshots/map-tab.png') });
});

test('re-clicking Neasden keeps user vertical exaggeration ×21', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByLabel('Vertical exaggeration').selectOption('21');
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await page.getByRole('button', { name: 'Maps ▾' }).click();
  await page.locator('.menu-pop').getByRole('button', { name: /^Neasden\b/ }).first().click();
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await page.locator('.map-preset-row').getByRole('button', { name: 'Neasden', exact: true }).click();
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
});

test('neasden ×11 and ×21 have no 2 mm thin-neck fit warnings', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  for (const ex of ['11', '21']) {
    await page.getByLabel('Vertical exaggeration').selectOption(ex);
    await waitForMapReady(page);
    await assertNoThin2mmWarnings(page);
    await assertZeroFitErrors(page);
  }
});

test('stamped stack + neasden ×11 and ×21 have no fit errors', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: /Stamped stack/ }).click();
  await expect(page.locator('.status-bar-field').filter({ hasText: /parts/ })).toContainText(/\d+\s+parts/, { timeout: 90_000 });
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  for (const ex of ['11', '21']) {
    await page.getByLabel('Vertical exaggeration').selectOption(ex);
    await waitForMapReady(page);
    await assertZeroFitErrors(page);
    await assertNoThin2mmWarnings(page);
  }
});

test('neasden 3D and Plates screenshots in light and dark', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);
  await waitForViewportRelief(page);

  const shotDir = join(process.cwd(), 'docs/screenshots/map-p0');
  await mkdir(shotDir, { recursive: true });

  for (const { theme, prefix, mode } of [
    { theme: 'Paper', prefix: 'light', mode: 'light' as const },
    { theme: 'Ink', prefix: 'dark', mode: 'dark' as const },
  ]) {
    await setThemePreset(page, theme);
    await waitForThemeMode(page, mode);
    await openWorkspaceTab(page, '3D');
    await expect(page.locator('.main canvas').first()).toBeVisible();
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-3d.png`) });
    await waitForPlatesView(page);
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-plates.png`) });
  }
});
