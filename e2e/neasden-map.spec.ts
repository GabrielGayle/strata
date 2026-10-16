import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openWorkspaceTab, pickNeasdenPreset, assertMapPreviewNonUniform, assertPlateHeightMatchesRelief, setThemePreset, waitForViewportRelief } from './map-helpers';

test('neasden map plates follow real elevation × exaggeration (fixture)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await pickNeasdenPreset(page);

  const partsText = await page.locator('.status-bar-field').first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await assertPlateHeightMatchesRelief(page, 0.3);
  await openWorkspaceTab(page, 'Map');
  await assertMapPreviewNonUniform(page);

  await mkdir(join(process.cwd(), 'docs/screenshots'), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), 'docs/screenshots/neasden-map-3d.png'), fullPage: false });
  await page.locator('.map-view').screenshot({ path: join(process.cwd(), 'docs/screenshots/map-tab.png') });
});

test('neasden 3D and Plates screenshots in light and dark', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, '3D');
  await waitForViewportRelief(page);

  const shotDir = join(process.cwd(), 'docs/screenshots/map-p0');
  await mkdir(shotDir, { recursive: true });

  for (const { theme, prefix } of [
    { theme: 'Paper', prefix: 'light' },
    { theme: 'Ink', prefix: 'dark' },
  ]) {
    await setThemePreset(page, theme);
    await page.waitForTimeout(500);
    await openWorkspaceTab(page, '3D');
    await page.waitForTimeout(800);
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-3d.png`) });
    await openWorkspaceTab(page, 'Plates');
    await page.waitForTimeout(400);
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-plates.png`) });
  }
});
