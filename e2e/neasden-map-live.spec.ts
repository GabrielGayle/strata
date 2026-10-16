import { test, expect } from '@playwright/test';
import { openApp, pickNeasdenPreset, openWorkspaceTab, assertPlateHeightMatchesRelief } from './map-helpers';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live network map smoke tests');

test('neasden map uses live EA 1 m, OSM engrave, and map preview', async ({ page }) => {
  test.setTimeout(420_000);

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

  await openApp(page);
  // Toolbar Maps ▾ → Neasden auto-builds (~100 s live). There is no Build button.
  await pickNeasdenPreset(page);
  await assertPlateHeightMatchesRelief(page, 0.35);
  const rangeMm = Number(await page.locator('.app.window').getAttribute('data-strata-plate-height-range-mm'));
  expect(rangeMm).toBeGreaterThan(70);
  // #85 live 3D caption was "plate height 232–264 mm" (strata). True relief (~55 m) ×11 → ~4–150 mm.
  await openWorkspaceTab(page, '3D');
  await expect(page.getByTestId('plate-height-range')).toBeVisible();
  await expect(page.getByTestId('plate-height-range')).toContainText(/terrain/i);
  await expect(page.getByTestId('plate-height-range')).not.toContainText(/232\s*[–-]\s*264/);

  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-terrain-status')).toContainText(/ready|Exaggeration/i, { timeout: 300_000 });

  const ea = await eaHit;
  expect(ea.status()).toBe(200);
  expect(decodeURIComponent(ea.url())).toMatch(/environment\.data\.gov\.uk\/geoservices\/datasets\/.+\/wcs/);
  expect(decodeURIComponent(ea.url())).toMatch(/SCALEFACTOR=/);

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

  await expect(page.locator('.issue').filter({ hasText: /narrower than 2 mm/ })).toHaveCount(0);
});
