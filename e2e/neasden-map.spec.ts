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

  const partsText = await page.locator('.status-bar-field').first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await assertPlateHeightMatchesRelief(page, 0.3);
  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-view h2')).toBeVisible();
  await expect(page.locator('#map-model-dtm')).toBeChecked();
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  await assertMapPreviewNonUniform(page);

  await mkdir(join(process.cwd(), 'docs/screenshots'), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), 'docs/screenshots/neasden-map-3d.png'), fullPage: false });
  await page.locator('.map-view').screenshot({ path: join(process.cwd(), 'docs/screenshots/map-tab.png') });
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
