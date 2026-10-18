import { test, expect } from '@playwright/test';
import { openApp, openWorkspaceTab, pickNeasdenPreset, waitForMapReady } from './map-helpers';

test('a second terrain build of the same area reads tiles from the browser cache', async ({ page }) => {
  const tileRequests: string[] = [];
  page.on('request', (req) => {
    if (/\/map-fixtures\/|elevation-tiles-prod/.test(req.url())) tileRequests.push(req.url());
  });
  await openApp(page);
  await pickNeasdenPreset(page);
  expect(tileRequests.length).toBeGreaterThan(0);

  // Water mode is part of the build key, so this rebuilds the same bbox.
  tileRequests.length = 0;
  await openWorkspaceTab(page, 'Map');
  await page.locator('label[for="map-water-raw"]').click();
  await expect(page.locator('#map-water-raw')).toBeChecked();
  await waitForMapReady(page);
  expect(tileRequests).toEqual([]);
});
