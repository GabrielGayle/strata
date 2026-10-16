import { test, expect } from '@playwright/test';
import { applyNeasdenDesign, openWorkspaceTab } from './map-helpers';

test('depth near/far sliders stick after map rebuild', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await applyNeasdenDesign(page);

  await openWorkspaceTab(page, 'Image / Graphic');
  const topCard = page.locator('.window.box').filter({ hasText: 'Top surface image' }).first();
  await topCard.getByRole('button', { name: 'Image', exact: true }).click();
  const nearRow = topCard.getByRole('slider', { name: 'Near' });
  await nearRow.waitFor({ state: 'visible', timeout: 120_000 });

  const nearMono = () => topCard.locator('label.pm-row:has([aria-label="Near"]) .mono');
  const nearBefore = await nearMono().textContent();
  const slider = nearRow;
  const box = await slider.boundingBox();
  if (!box) throw new Error('near slider missing');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const nearTuned = await nearMono().textContent();
  expect(nearTuned).not.toBe(nearBefore);

  await openWorkspaceTab(page, 'Map');
  await page.getByRole('button', { name: 'Neasden' }).click();
  await expect(page.locator('.status-bar')).toContainText(/Map terrain ready/i, { timeout: 240_000 });

  await openWorkspaceTab(page, 'Image / Graphic');
  const topAgain = page.locator('.window.box').filter({ hasText: 'Top surface image' }).first();
  await topAgain.getByRole('button', { name: 'Image', exact: true }).click();
  await topAgain.getByRole('slider', { name: 'Near' }).waitFor({ state: 'visible' });
  const nearAfter = await topAgain.locator('label.pm-row:has([aria-label="Near"]) .mono').textContent();
  expect(nearAfter).toBe(nearTuned);
});
