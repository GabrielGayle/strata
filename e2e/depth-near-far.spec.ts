import { test, expect } from '@playwright/test';
import { openApp, openWorkspaceTab, pickNeasdenPreset, plateHeightRangeMm, waitForMapReady } from './map-helpers';

async function setRangeInput(locator: import('@playwright/test').Locator, t: number) {
  await locator.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(Math.round(value * Number(input.max || 1000))));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, t);
}

test('depth near/far sliders change plates and survive a map rebuild', async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await pickNeasdenPreset(page);

  const rangeBefore = await plateHeightRangeMm(page);
  expect(rangeBefore).toBeGreaterThan(20);

  await openWorkspaceTab(page, 'Image / Graphic');
  const topCard = page.locator('.window.box').filter({ hasText: 'Top surface image' }).first();
  await topCard.getByRole('button', { name: 'Image', exact: true }).click();
  const nearRow = topCard.getByRole('slider', { name: 'Near' });
  await nearRow.waitFor({ state: 'visible', timeout: 30_000 });

  const nearMono = () => topCard.locator('label.pm-row:has([aria-label="Near"]) .mono');
  const farRow = topCard.getByRole('slider', { name: 'Far' });
  const nearBefore = await nearMono().textContent();
  await setRangeInput(nearRow, 0.35);
  await setRangeInput(farRow, 0.65);
  await expect.poll(async () => nearMono().textContent(), { timeout: 15_000 }).not.toBe(nearBefore);
  const nearTuned = await nearMono().textContent();

  await expect
    .poll(async () => plateHeightRangeMm(page), { timeout: 30_000 })
    .not.toBeCloseTo(rangeBefore, 0);
  const rangeTuned = await plateHeightRangeMm(page);
  expect(rangeTuned).not.toBe(rangeBefore);

  await openWorkspaceTab(page, 'Map');
  await page.locator('.map-preset-row').getByRole('button', { name: 'Neasden', exact: true }).click();
  await waitForMapReady(page);

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
