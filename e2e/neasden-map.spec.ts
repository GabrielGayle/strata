import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dismissTour, openWorkspaceTab, skipStartupTour } from './map-helpers';

test('neasden map design builds a carved top with plates', async ({ page }) => {
  await skipStartupTour(page);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });

  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input');
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.locator('.status-bar')).toContainText(/Fetching|building/i, { timeout: 15_000 });
  await expect(page.locator('.status-bar')).toContainText(/ready/i, { timeout: 120_000 });
  await dismissTour(page);

  const partsText = await page.locator('.status-bar-field').first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-view h2')).toBeVisible();
  const dtm = page.locator('#map-model-dtm');
  await expect(dtm).toBeChecked();
  await expect.poll(async () => dtm.evaluate((el) => el.nextElementSibling?.getAttribute('for'))).toBe('map-model-dtm');
  await expect(page.locator('label[for="map-model-dtm"]')).toBeVisible();
  await expect(page.locator('#map-water-bathy')).toBeChecked();

  await page.getByLabel('Vertical exaggeration').selectOption('21');
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await page.getByRole('button', { name: /^Maps/ }).click();
  await page.locator('.tree-view button').filter({ has: page.locator('span', { hasText: /^Neasden$/ }) }).click();
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await page.locator('.map-preset-row').getByRole('button', { name: 'Neasden', exact: true }).click();
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');

  const shotDir = join(process.cwd(), 'docs/screenshots');
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'neasden-map-3d.png'), fullPage: false });
  await page.locator('.map-view').screenshot({ path: join(shotDir, 'map-tab.png') });
});
