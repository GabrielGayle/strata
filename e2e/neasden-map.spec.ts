import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('neasden map design builds a carved top with plates', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('strata:tour-seen', '1');
  });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  // Blur the parameter filter so `/` is not eaten as text input.
  await page.locator('.status-bar').click();
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.design-box .design-input', { timeout: 15_000 });
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.locator('.status-bar')).toContainText(/Fetching|building/i, { timeout: 15_000 });
  await expect(page.locator('.status-bar')).toContainText(/ready/i, { timeout: 120_000 });

  const partsText = await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await page.getByRole('button', { name: /Maps/ }).click();
  await page.getByRole('button', { name: 'Open Map tab' }).click();
  await expect(page.locator('.map-view h2')).toBeVisible();

  const shotDir = join(process.cwd(), 'docs/screenshots');
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'neasden-map-3d.png'), fullPage: false });
  await page.locator('.map-view').screenshot({ path: join(shotDir, 'map-tab.png') });
});
