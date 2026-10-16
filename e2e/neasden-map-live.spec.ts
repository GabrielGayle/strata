import { test, expect } from '@playwright/test';
import { pickNeasdenPreset, openWorkspaceTab, assertPlateHeightMatchesRelief } from './map-helpers';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live network map smoke tests');

test('neasden map uses live EA 1 m, OSM engrave, and map preview', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  // Toolbar Maps ▾ → Neasden auto-builds (~100 s live). There is no Build button.
  await pickNeasdenPreset(page);
  await assertPlateHeightMatchesRelief(page, 0.35);

  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-terrain-status')).toContainText(/ready|Exaggeration/i, { timeout: 240_000 });

  await expect(page.locator('.map-view-layout')).toHaveAttribute('data-strata-resolved-source', 'ea-dtm', { timeout: 240_000 });
  await expect
    .poll(async () => Number(await page.locator('.map-view-layout').getAttribute('data-strata-map-engrave-count')), {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('.map-preview-canvas') as HTMLCanvasElement | null;
          if (!canvas || canvas.width < 16) return 0;
          const ctx = canvas.getContext('2d');
          if (!ctx) return 0;
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const keys = new Set<number>();
          for (let i = 0; i < img.length; i += 4) {
            if (img[i + 3] === 0) continue;
            keys.add(img[i] * 65536 + img[i + 1] * 256 + img[i + 2]);
          }
          return keys.size;
        }),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(3);
});
