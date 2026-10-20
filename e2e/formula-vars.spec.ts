import { test, expect } from '@playwright/test';

test('ƒ lists the names a formula can use, and clicking one types it in', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await page.getByLabel('Filter parameters').fill('baseHeight');
  const row = page.locator('[data-param="baseHeight"]');
  await row.getByTitle('Edit as expression (link to other parameters)').click();
  const box = row.getByLabel('Height expression');
  await expect(box).toBeFocused();
  const list = page.getByRole('listbox', { name: /formula/ });
  await expect(list).toBeVisible();
  // grouped, with the current value beside each name
  await expect(list.locator('.fx-head', { hasText: 'Functions' })).toBeVisible();
  await expect(list.getByRole('option', { name: /^baseLength/ })).toContainText(/\d/);
  // typing filters it; Enter takes the highlighted name
  await box.fill('');
  await box.pressSequentially('floor(baseWi');
  await expect(list.getByRole('option').first()).toContainText('baseWidth');
  await box.press('Enter');
  await expect(box).toHaveValue('floor(baseWidth');
  await expect(list).toBeHidden();
  // ▾ shows the lot again; a click puts the name in at the caret
  await box.pressSequentially(' / ');
  await row.getByRole('button', { name: /Names for/ }).click();
  await page.screenshot({ path: 'docs/screenshots/formula-vars.png', clip: { x: 0, y: 0, width: 640, height: 640 } });
  await list.getByRole('option', { name: /^thickness/ }).click();
  await expect(box).toHaveValue('floor(baseWidth / thickness');
  await expect(box).toBeFocused();
  await box.pressSequentially(' / 4)');
  await box.press('Enter');
  await expect(box).not.toBeFocused();
  await expect(row.locator('.perr')).toHaveCount(0);
});
