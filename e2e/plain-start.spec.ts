import { test, expect } from '@playwright/test';
import { openApp } from './map-helpers';

const counts = (page: import('@playwright/test').Page) => page.getByTestId('status-counts');

test('a new project is the plain A5 slab, and its switches bring plates, strata and insert back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page, { preset: null });
  await expect(page.locator('.topbar input').first()).toHaveValue('Plain A5 base');
  await expect(counts(page)).toContainText(/^0 plates/, { timeout: 60_000 });
  await expect(page.locator('.statusbar')).toContainText('0 errors');
  await expect(page.locator('.statusbar')).toContainText('0 warnings');

  for (const g of ['Plates', 'Strata', 'Insert']) {
    const sw = page.locator(`fieldset.section[data-group="${g}"]`).getByRole('switch', { name: `${g} on` });
    await expect(sw).not.toBeChecked();
    await sw.click();
    await expect(sw).toBeChecked();
  }
  await expect(counts(page)).toContainText(/^16 plates/, { timeout: 60_000 });
  await expect(page.locator('.statusbar')).toContainText('0 errors');
  await expect(page.locator('.statusbar')).toContainText('0 warnings');
});
