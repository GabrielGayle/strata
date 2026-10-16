import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyNeasdenDesign, openWorkspaceTab, setThemePreset, waitForViewportRelief } from './map-helpers';

const shotDir = join(process.cwd(), 'docs/screenshots/map-live');

test.skip(!process.env.LIVE_MAP_SCREENSHOTS, 'Set LIVE_MAP_SCREENSHOTS=1 to capture docs/screenshots/map-live (real network)');

test('capture live map UI screenshots', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await applyNeasdenDesign(page);
  await mkdir(shotDir, { recursive: true });
  await openWorkspaceTab(page, '3D');
  await waitForViewportRelief(page);

  for (const { theme, prefix } of [
    { theme: 'Paper', prefix: 'light' },
    { theme: 'Ink', prefix: 'dark' },
  ]) {
    await setThemePreset(page, theme);
    await page.waitForTimeout(400);
    await openWorkspaceTab(page, '3D');
    await page.waitForTimeout(800);
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-3d.png`) });
    await openWorkspaceTab(page, 'Map');
    await page.locator('.map-view-layout').waitFor({ state: 'visible' });
    await expect(page.locator('#map-model-dtm')).toBeChecked();
    await expect(page.locator('#map-water-bathy')).toBeChecked();
    await page.waitForTimeout(2000);
    await page.locator('.map-view-layout').screenshot({ path: join(shotDir, `${prefix}-map-preview.png`) });
    await page.locator('.map-view fieldset', { hasText: 'Ground model' }).screenshot({
      path: join(shotDir, `${prefix}-ground-model.png`),
    });
    await page.locator('.map-section', { hasText: 'Water & bathymetry' }).screenshot({
      path: join(shotDir, `${prefix}-water.png`),
    });
  }
});
