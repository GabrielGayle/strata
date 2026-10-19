import { test, expect, devices } from '@playwright/test';
import { e2eOwnerToken } from '../playwright.env';

// The phone viewer (/m): a phone opening the editor's address lands there, unlocks
// the cloud library, opens a saved project in 3D and gets an AR file for it.

const iPhone = devices['iPhone 13'];
test.use({ viewport: iPhone.viewport, userAgent: iPhone.userAgent, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const ID = 'e2e-phone-viewer';
const NAME = 'Phone viewer check';

test('a saved project opens on a phone, in 3D and as an AR file', async ({ page, request }) => {
  test.setTimeout(180_000);
  const token = e2eOwnerToken();
  const auth = { Authorization: `Bearer ${token}` };
  const data = JSON.stringify({ format: 'strata-project', version: 1, name: NAME });
  const now = Date.now();
  const put = await request.put(`/api/projects?id=${ID}`, {
    headers: auth,
    data: { meta: { id: ID, name: NAME, savedAt: now, openedAt: now, updatedAt: now, size: data.length, kind: 'Vermilion' }, data },
  });
  expect(put.ok()).toBeTruthy();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto('/');
    await expect(page).toHaveURL(/\/m$/);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.locator('.mv-item', { hasText: NAME }).click();
    await expect(page).toHaveURL(new RegExp(`\\?p=${ID}$`));
    const ar = page.getByTestId('mobile-ar');
    await expect(ar).toBeEnabled({ timeout: 120_000 });
    await expect(page.getByTestId('mobile-ar-note')).toContainText('True size 800 × 300');
    const [download] = await Promise.all([page.waitForEvent('download'), ar.click()]);
    expect(download.suggestedFilename()).toBe(`${NAME}.usdz`);
    await page.getByRole('tab', { name: 'Details' }).click();
    await expect(page.getByTestId('mobile-details')).toContainText('40 @');
    await page.getByRole('button', { name: '◀ Projects' }).click();
    await expect(page.getByTestId('mobile-project-list')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects?id=${ID}`, { headers: auth });
  }
});
