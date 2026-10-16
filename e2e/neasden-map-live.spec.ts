import { test, expect } from '@playwright/test';
import { clickMapPreset } from './map-helpers';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live network map smoke tests');

test('neasden map uses live EA 1 m, OSM engrave, and map preview', async ({ page }) => {
  const eaHit = page.waitForResponse(
    (r) => {
      let url = r.url();
      try {
        url = decodeURIComponent(url);
      } catch {
        /* keep raw */
      }
      return (
        url.includes('/api/ea-proxy') &&
        url.includes('environment.data.gov.uk') &&
        url.includes('/wcs') &&
        r.ok()
      );
    },
    { timeout: 180_000 },
  );

  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await clickMapPreset(page, 'Neasden');
  await expect(page.locator('.status-bar')).toContainText(/Fetching|building|Queued|ready/i, { timeout: 15_000 });
  await expect(page.locator('.map-terrain-status')).toContainText(/ready|Exaggeration/i, { timeout: 240_000 });

  const ea = await eaHit;
  expect(ea.status()).toBe(200);
  expect(decodeURIComponent(ea.url())).toMatch(/environment\.data\.gov\.uk\/geoservices\/datasets\/.+\/wcs/);

  await expect(page.locator('.map-view-layout')).toHaveAttribute('data-strata-resolved-source', 'ea-dtm', { timeout: 240_000 });
  await expect(page.locator('.map-readout')).toContainText(/source ea-dtm/i);
  await expect(page.locator('.map-view')).not.toContainText(/falling back to terrarium/i);

  await expect(page.locator('#map-model-dtm')).toBeChecked();
  await expect(page.locator('#map-water-bathy')).toBeChecked();

  await expect
    .poll(async () => Number(await page.locator('.map-view-layout').getAttribute('data-strata-map-engrave-count')), {
      timeout: 120_000,
    })
    .toBeGreaterThan(0);

  const skipVisible = await page.locator('.map-notices li', { hasText: /OSM engrave skipped/i }).count();
  const engraveCount = Number(await page.locator('.map-view-layout').getAttribute('data-strata-map-engrave-count'));
  expect(skipVisible === 0 || engraveCount === 0).toBe(true);

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
