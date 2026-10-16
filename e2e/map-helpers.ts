import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

/** First-visit Help tour (1.5 s) covers the chrome and steals toolbar clicks. */
export async function dismissTour(page: Page) {
  const dlg = page.getByRole('dialog', { name: /Tour:/ });
  const visible = await dlg.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true).catch(() => false);
  if (!visible) return;
  await dlg.getByRole('button', { name: 'Skip' }).click();
  await dlg.waitFor({ state: 'hidden', timeout: 5_000 });
}

export async function clickMapPreset(page: Page, label: string) {
  await dismissTour(page);
  await openWorkspaceTab(page, 'Map');
  await page.locator('.map-preset-row').getByRole('button', { name: label, exact: true }).click();
}

export async function applyNeasdenDesign(page: Page) {
  await dismissTour(page);
  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input');
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.status-bar')).toContainText(/Fetching|building/i, { timeout: 15_000 });
  await expect(page.locator('.status-bar')).toContainText(/ready/i, { timeout: 240_000 });
  await dismissTour(page);
}

export async function openWorkspaceTab(page: Page, label: string) {
  await page.locator('.ws-tabs [role="tab"]', { hasText: label }).click();
}

export async function waitForViewportRelief(page: Page) {
  const canvas = page.locator('.main canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const buf = await canvas.screenshot({ type: 'png' });
        const png = PNG.sync.read(Buffer.from(buf));
        const keys = new Set<number>();
        for (let i = 0; i < png.data.length; i += 16) {
          if (png.data[i + 3] < 8) continue;
          keys.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
          if (keys.size >= 8) return keys.size;
        }
        return keys.size;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

export async function setThemePreset(page: Page, name: string) {
  await page.getByRole('button', { name: 'Appearance ▾' }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
