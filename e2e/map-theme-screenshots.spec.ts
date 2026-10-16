import { test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyNeasdenDesign, openWorkspaceTab, setThemePreset, waitForViewportRelief } from './map-helpers';

const shotDir = join(process.cwd(), 'docs/screenshots/map');

test('capture map UI screenshots in light and dark themes', async ({ page }) => {
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

    await openWorkspaceTab(page, 'Plates');
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-plates.png`) });

    await openWorkspaceTab(page, 'Map');
    await page.locator('.map-view').waitFor({ state: 'visible' });
    await page.locator('.map-view').screenshot({ path: join(shotDir, `${prefix}-map.png`) });
  }
});
