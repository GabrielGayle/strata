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

  const radius = page.getByLabel(/How tightly the arc curves/);
  const auto = page.getByRole('button', { name: 'Reset Radius to auto' });
  await radius.click();
  await radius.press('ControlOrMeta+A');
  await radius.pressSequentially('450');
  await radius.blur();
  await expect(auto).toHaveCount(0);
  await radius.fill('200');
  await radius.blur();
  await expect(auto).toBeVisible();
  await auto.click();
  await expect(auto).toHaveCount(0);

  await page.getByRole('checkbox', { name: 'Unobstructed view' }).check();
  await expect(page.getByTestId('shelf-camera-note')).toBeVisible();
  await expect(page.getByTestId('shelf-camera-note')).toContainText(/camera/i);

  const fit = page.getByTestId('fit-checks');
  await fit.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => fit.locator('[data-issue-type="hidden"]').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(fit.locator('[data-issue-type="hidden"][data-issue-severity="error"]')).toHaveCount(0);

  await page.getByRole('button', { name: /Unobstructed view \(dev\)/ }).click();
  const dev = page.getByTestId('shelf-unobstructed-dev');
  await expect(dev).toBeVisible();
  await expect(dev).toHaveClass(/shelf-view-dock/);

  await page.getByRole('checkbox', { name: 'Unobstructed view' }).uncheck();
  await expect
    .poll(async () => fit.locator('[data-issue-type="hidden"][data-issue-severity="error"]').count(), { timeout: 30_000 })
    .toBe(0);
});
