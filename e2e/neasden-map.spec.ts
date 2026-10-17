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
} from './map-helpers';

test('neasden map plates follow real elevation × exaggeration (fixture)', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);

  const partsText = await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await assertPlateHeightMatchesRelief(page, 0.3);
  await openWorkspaceTab(page, '3D');
  const caption = (await page.getByTestId('plate-height-range').textContent())?.trim() ?? '';
  expect(caption).toMatch(/terrain \d+[–-]\d+ mm/);

  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-view h2')).toBeVisible();
  await expect(page.getByTestId('map-readout')).toContainText(caption);
  await expect(page.getByTestId('sunken-frame-checkbox')).toBeDisabled();
  await expect(page.locator('#map-sunken-frame-hint')).toContainText(/Stamped stack \(flat layers\)/);
  const dtm = page.locator('#map-model-dtm');
  await expect(dtm).toBeChecked();
  await expect.poll(async () => dtm.evaluate((el) => el.nextElementSibling?.getAttribute('for'))).toBe('map-model-dtm');
  await expect(page.locator('label[for="map-model-dtm"]')).toBeVisible();
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  await assertMapPreviewNonUniform(page);

  await mkdir(join(process.cwd(), 'docs/screenshots'), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), 'docs/screenshots/neasden-map-3d.png'), fullPage: false });
  await page.getByTestId('sunken-frame-checkbox').scrollIntoViewIfNeeded();
  await page.locator('.map-view').screenshot({ path: join(process.cwd(), 'docs/screenshots/map-tab.png') });
});

test('Stamped stack map readout matches stack height; sunken frame is enabled', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Presets ▾' }).click();
  await page.locator('.menu-pop').getByRole('button', { name: /Stamped stack/ }).click();
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, '3D');
  const caption = (await page.getByTestId('plate-height-range').textContent())?.trim() ?? '';
  expect(caption).toMatch(/stack height \d+ mm/);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByTestId('map-readout')).toContainText(caption);
  await expect(page.getByTestId('sunken-frame-checkbox')).toBeEnabled();
  await expect(page.locator('#map-sunken-frame-hint')).toHaveCount(0);
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
