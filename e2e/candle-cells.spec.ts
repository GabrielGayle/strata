import { test, expect } from '@playwright/test';
import { openApp } from './map-helpers';

// Candelabra › Snap › Centre in the cells, on a shelf: screenshots only (positions are pinned by test/candle-cells.test.ts).
const shot = process.env.STRATA_SHOTS;

test('candles centre in the cells of a shelf', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openApp(page);
  const canvas = page.locator('.ws-pane canvas').first();
  await expect(canvas).toBeVisible();
  await page.getByTestId('sidebar-tab-candles').click();
  await page.getByRole('button', { name: '+ Candelabra' }).click();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/c1-anywhere.png` });
  await page.getByLabel('Snap').selectOption('cells');
  await page.waitForTimeout(3000);
  if (shot) await canvas.screenshot({ path: `${shot}/c2-cells.png` });
  await page.locator('.overlay.tl').getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/c3-cells-top.png` });
  expect(errors).toEqual([]);
});
