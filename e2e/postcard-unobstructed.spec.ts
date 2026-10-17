import { expect, test } from '@playwright/test';
import { openApp } from './map-helpers';

test('Unobstructed view on the postcard shelf shows in Fit checks', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);

  await page.getByTitle(/Place postcards, boxes and other objects/).click();
  await page.getByRole('button', { name: 'Postcard shelf' }).click();
  await page.getByRole('button', { name: '+ Postcard shelf' }).click();
  await expect(page.getByLabel('Layout')).toBeVisible();
  await page.getByLabel('Layout').selectOption('arch');

  await page.getByRole('button', { name: /Unobstructed view \(dev\)/ }).click();
  const dev = page.getByTestId('shelf-unobstructed-dev');
  await expect(dev.getByRole('checkbox', { name: 'Unobstructed view' })).toBeVisible();

  const fit = page.getByTestId('fit-checks');
  await fit.scrollIntoViewIfNeeded();

  await dev.getByRole('checkbox', { name: 'Unobstructed view' }).check();
  await expect
    .poll(async () => fit.locator('[data-issue-type="hidden"]').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(fit.locator('[data-issue-type="hidden"][data-issue-severity="error"]')).toHaveCount(0);
  await expect(fit).toContainText(/every postcard face is visible/i);

  await dev.getByRole('checkbox', { name: 'Unobstructed view' }).uncheck();
  await expect
    .poll(async () => fit.locator('[data-issue-type="hidden"][data-issue-severity="error"]').count(), { timeout: 30_000 })
    .toBe(0);
});
