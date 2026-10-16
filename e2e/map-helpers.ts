import { expect, type Page } from '@playwright/test';

export async function clickMapPreset(page: Page, label: string) {
  await openWorkspaceTab(page, 'Map');
  await page.locator('.map-preset-row').getByRole('button', { name: label, exact: true }).click();
}

export async function applyNeasdenDesign(page: Page) {
  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input');
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.status-bar')).toContainText(/Fetching|building/i, { timeout: 15_000 });
  await expect(page.locator('.status-bar')).toContainText(/ready/i, { timeout: 120_000 });
}

export async function openWorkspaceTab(page: Page, label: string) {
  await page.locator('.ws-tabs [role="tab"]', { hasText: label }).click();
}

export async function waitForViewportRelief(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('.main canvas') as HTMLCanvasElement | null;
          if (!canvas || canvas.width < 16) return false;
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (!gl) return false;
          const pixels = new Uint8Array(4 * 64);
          gl.readPixels(
            Math.floor(canvas.width * 0.35),
            Math.floor(canvas.height * 0.35),
            8,
            8,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
          );
          const keys = new Set<number>();
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] === 0) continue;
            keys.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
          }
          return keys.size >= 3;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

export async function setThemePreset(page: Page, name: string) {
  await page.getByRole('button', { name: 'Appearance ▾' }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
