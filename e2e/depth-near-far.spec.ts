import { test, expect } from '@playwright/test';
import { openWorkspaceTab, pickNeasdenPreset, plateHeightRangeMm } from './map-helpers';

test('depth near/far sliders change plates and survive a map rebuild', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await pickNeasdenPreset(page);

  const rangeBefore = await plateHeightRangeMm(page);
  expect(rangeBefore).toBeGreaterThan(20);

  await openWorkspaceTab(page, 'Image / Graphic');
  const topCard = page.locator('.window.box').filter({ hasText: 'Top surface image' }).first();
  await topCard.getByRole('button', { name: 'Image', exact: true }).click();
  const nearRow = topCard.getByRole('slider', { name: 'Near' });
  await nearRow.waitFor({ state: 'visible', timeout: 120_000 });

  const nearMono = () => topCard.locator('label.pm-row:has([aria-label="Near"]) .mono');
  const farRow = topCard.getByRole('slider', { name: 'Far' });
  const nearBefore = await nearMono().textContent();
  const nearBox = await nearRow.boundingBox();
  const farBox = await farRow.boundingBox();
  if (!nearBox || !farBox) throw new Error('near/far sliders missing');
  await page.mouse.click(nearBox.x + nearBox.width * 0.35, nearBox.y + nearBox.height / 2);
  await page.mouse.click(farBox.x + farBox.width * 0.65, farBox.y + farBox.height / 2);
  await page.waitForTimeout(600);
  const nearTuned = await nearMono().textContent();
  expect(nearTuned).not.toBe(nearBefore);

  await expect
    .poll(async () => plateHeightRangeMm(page), { timeout: 30_000 })
    .not.toBeCloseTo(rangeBefore, 0);
  const rangeTuned = await plateHeightRangeMm(page);
  expect(rangeTuned).not.toBe(rangeBefore);

  await openWorkspaceTab(page, 'Map');
  await page.locator('.map-preset-row').getByRole('button', { name: 'Neasden', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText(/ready/i, { timeout: 240_000 });

  await openWorkspaceTab(page, 'Image / Graphic');
  const topAgain = page.locator('.window.box').filter({ hasText: 'Top surface image' }).first();
  await topAgain.getByRole('button', { name: 'Image', exact: true }).click();
  await topAgain.getByRole('slider', { name: 'Near' }).waitFor({ state: 'visible' });
  const nearAfter = await topAgain.locator('label.pm-row:has([aria-label="Near"]) .mono').textContent();
  expect(nearAfter).toBe(nearTuned);
  await expect
    .poll(async () => plateHeightRangeMm(page), { timeout: 30_000 })
    .toBeCloseTo(rangeTuned, 0);
});
