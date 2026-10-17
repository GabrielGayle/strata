import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openApp, pickNeasdenPreset, openWorkspaceTab, waitForMapReady, assertPlateHeightMatchesRelief } from './map-helpers';

async function readFit(page: import('@playwright/test').Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  const errorsText = await page.locator('.status-bar-field').filter({ hasText: /errors/ }).textContent();
  const warningsText = await page.locator('.status-bar-field').filter({ hasText: /warnings/ }).textContent();
  const thin = await page.locator('.issue').filter({ hasText: /narrower than 2 mm/ }).count();
  const kerf = await page.locator('.issue').filter({ hasText: /Gap narrower than the/ }).count();
  return {
    errors: Number(errorsText?.match(/(\d+)\s+errors/)?.[1] ?? -1),
    warnings: Number(warningsText?.match(/(\d+)\s+warnings/)?.[1] ?? -1),
    thin,
    kerf,
    errorsText: errorsText?.trim() ?? '',
    warningsText: warningsText?.trim() ?? '',
  };
}

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
  await expect(page.locator('.status-bar-field').filter({ hasText: /errors/ })).toHaveText('0 errors');
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

test('live Neasden ×11/×21 upright Vermilion and Stamped: 0 errors, no 2 mm thin', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await openApp(page);
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');

  const log: Record<string, Awaited<ReturnType<typeof readFit>>> = {};

  const check = async (label: string, ex: '11' | '21') => {
    await page.getByLabel('Vertical exaggeration').selectOption(ex);
    await waitForMapReady(page);
    await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
    const fit = await readFit(page);
    log[label] = fit;
    // eslint-disable-next-line no-console
    console.log(`live app ${label}`, fit);
    await page.locator('.statusbar').screenshot({
      path: testInfo.outputPath(`neasden_${label.replace(/\s+/g, '_')}_status.png`),
    });
    expect(fit.errors, `${label} ${fit.errorsText}`).toBe(0);
    expect(fit.thin, `${label} still has 2 mm thin warnings`).toBe(0);
    expect(fit.kerf, `${label} still has kerf-narrow gaps`).toBe(0);
  };

  await check('upright x11', '11');
  await check('upright x21', '21');

  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: /Stamped stack/ }).click();
  await expect(page.locator('.status-bar-field').filter({ hasText: /parts/ })).toContainText(/\d+\s+parts/, { timeout: 90_000 });
  await pickNeasdenPreset(page);

  const shotDir = join(process.cwd(), 'docs/screenshots');
  await mkdir(shotDir, { recursive: true });

  const snapStamped = async (ex: '11' | '21') => {
    await page.getByRole('tab', { name: 'Map', exact: true }).click();
    await expect(page.getByLabel('Vertical exaggeration')).toBeVisible();
    await check(`stamped x${ex}`, ex);
    await page.getByRole('tab', { name: '3D', exact: true }).click();
    await expect(page.getByTestId('plate-height-range')).toBeVisible();
    const caption = (await page.getByTestId('plate-height-range').textContent())?.trim() ?? '';
    const root = page.locator('.app.window');
    const metrics = {
      caption,
      factor: Number(await root.getAttribute('data-strata-map-exaggeration')),
      stackMm: Number(await root.getAttribute('data-strata-plate-height-range-mm')),
      wantedMm: Number(await root.getAttribute('data-strata-map-expected-height-mm')),
      terrainTopMm: Number(await root.getAttribute('data-strata-map-terrain-top-mm')),
      capped: await root.getAttribute('data-strata-map-stack-capped'),
    };
    const file = `stamped-neasden-x${ex}.png`;
    await page.locator('.main').screenshot({ path: join(shotDir, file) });
    await page.locator('.main').screenshot({ path: testInfo.outputPath(file) });
    return metrics;
  };

  const s11 = await snapStamped('11');
  const s21 = await snapStamped('21');
  expect(s11.factor).toBe(11);
  expect(s21.factor).toBe(21);
  expect(s11.stackMm).toBeGreaterThan(0);
  expect(s21.stackMm).toBe(s11.stackMm);
  expect(s21.wantedMm / s11.wantedMm).toBeGreaterThan(1.6);
  expect(s21.wantedMm / s11.wantedMm).toBeLessThan(2.2);
  expect(s11.caption).toMatch(/stack height \d+ mm/);
  expect(s21.caption).toMatch(/stack height \d+ mm/);
  if (s11.terrainTopMm > s11.stackMm + 3) {
    expect(s11.capped).toBe('1');
    expect(s11.caption).toMatch(/capped at \d+ layers/);
  }
  if (s21.terrainTopMm > s21.stackMm + 3) {
    expect(s21.capped).toBe('1');
    expect(s21.caption).toMatch(/capped at \d+ layers/);
  }
});
