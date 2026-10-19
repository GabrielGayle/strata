import { test, expect } from '@playwright/test';
import {
  applyMapBbox,
  assertZeroFitErrors,
  clickQuickMap,
  openApp,
  openWorkspaceTab,
  setBaseSizeMm,
  waitForMapReady,
} from './map-helpers';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live Buttermere summit height');

test('live Buttermere 500×500: max plate is ~851 m and fewer than 3 plates share it', async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await setBaseSizeMm(page, 500, 500);
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await clickQuickMap(page);
  await waitForMapReady(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByLabel('Vertical exaggeration').selectOption('4');
  await waitForMapReady(page);
  await assertZeroFitErrors(page);

  const root = page.locator('.app.window');
  await expect(root).toHaveAttribute('data-strata-map-phase', 'ready');

  const zMax = Number(await root.getAttribute('data-strata-map-z-max-m'));
  const atMax = Number(await root.getAttribute('data-strata-plates-at-max'));
  const relief = Number(await root.getAttribute('data-strata-map-relief-m'));
  expect(zMax, 'snapped DEM max should be Grasmoor (~851 m)').toBeGreaterThan(848);
  expect(zMax).toBeLessThan(854);
  expect(atMax, 'distinct summits must not share one plateau').toBeGreaterThan(0);
  expect(atMax).toBeLessThan(3);
  expect(relief).toBeGreaterThan(700);

  await openWorkspaceTab(page, '3D');
  await expect(page.getByTestId('plate-height-range')).toContainText(/terrain/i);
});
