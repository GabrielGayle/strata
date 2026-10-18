import { test, expect } from '@playwright/test';
import {
  applyMapBbox,
  assertZeroFitErrors,
  attachDialogGuard,
  clickQuickMap,
  injectNodataBlendedDem,
  openApp,
  setBaseSizeMm,
  waitForMapReady,
  waitForMapTerrainError,
  waitUntilMapNotStuckQueued,
} from './map-helpers';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';

test('Buttermere bbox + Quick map: no RangeTest dialog, map ready, 0 errors', async ({ page }) => {
  test.setTimeout(360_000);
  const dialogs = attachDialogGuard(page);
  await openApp(page);
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await setBaseSizeMm(page, 500, 500);
  await clickQuickMap(page);
  await waitForMapReady(page);
  await assertZeroFitErrors(page);
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-phase', 'ready');
  await expect(page.getByTestId('map-terrain-error')).toHaveCount(0);
  expect(dialogs, dialogs.join(' | ')).toEqual([]);
});

test('nodata-blended DEM shows a friendly Map tab error and no dialog', async ({ page }) => {
  test.setTimeout(360_000);
  const dialogs = attachDialogGuard(page);
  await injectNodataBlendedDem(page);
  await openApp(page);
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await setBaseSizeMm(page, 500, 500);
  await clickQuickMap(page);
  await waitForMapTerrainError(page);
  await expect(page.locator('.toast.window')).toContainText(/Couldn't build plates/i, { timeout: 8_000 });
  expect(dialogs, dialogs.join(' | ')).toEqual([]);
});

test('Quick map after a terrain failure rebuilds instead of sitting on Queued', async ({ page }) => {
  test.setTimeout(360_000);
  const dialogs = attachDialogGuard(page);
  await injectNodataBlendedDem(page);
  await openApp(page);
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await setBaseSizeMm(page, 500, 500);
  await clickQuickMap(page);
  await waitForMapTerrainError(page, /Couldn't build plates.*gap or bad value/i);

  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await waitUntilMapNotStuckQueued(page);
  await waitForMapTerrainError(page, /Couldn't build plates.*gap or bad value/i);

  await clickQuickMap(page);
  await waitUntilMapNotStuckQueued(page);
  await waitForMapTerrainError(page, /Couldn't build plates.*gap or bad value/i);

  await page.unroute('**/map-fixtures/regional/neasden-ea-dtm.json');
  await clickQuickMap(page);
  await waitUntilMapNotStuckQueued(page);
  await waitForMapReady(page);
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-phase', 'ready');
  expect(dialogs, dialogs.join(' | ')).toEqual([]);
});
