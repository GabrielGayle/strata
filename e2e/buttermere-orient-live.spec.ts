import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDesignText,
  applyMapBbox,
  assertZeroFitErrors,
  clickQuickMap,
  compressPngFile,
  downscalePng,
  openApp,
  openWorkspaceTab,
  snapViewportDir,
  stitchPngSideBySide,
  waitForMapReady,
  waitForViewportRelief,
} from './map-helpers';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live Buttermere orientation');

const shotDir = join(process.cwd(), 'docs/screenshots/buttermere');
const shotName = process.env.BUTTERMERE_ORIENT_SHOT === 'before' ? 'orient-before.png' : 'orient-after.png';

test('live Buttermere 500×500: 3D Top north matches Map preview', async ({ page }) => {
  test.setTimeout(420_000);
  await mkdir(shotDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await applyDesignText(page, 'base 500 × 500 mm');
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await clickQuickMap(page);
  await waitForMapReady(page);
  await assertZeroFitErrors(page);

  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-phase', 'ready');
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  await expect(page.getByLabel('OSM engrave on top face')).toBeChecked();

  await snapViewportDir(page, 'top', true);
  await waitForViewportRelief(page);
  const top3d = page.getByTestId('viewport-3d');
  await expect(top3d.getByRole('button', { name: 'Top' })).toHaveClass(/on/);
  await expect(page.getByTestId('plate-height-range')).toContainText(/terrain/i);
  const threeBuf = Buffer.from(await top3d.screenshot({ type: 'png' }));

  await openWorkspaceTab(page, 'Map');
  const preview = page.locator('.map-preview-canvas');
  await expect(preview).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('.map-preview-canvas') as HTMLCanvasElement | null;
          return canvas?.width ?? 0;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(16);
  const mapBuf = Buffer.from(await preview.screenshot({ type: 'png' }));

  const dest = join(shotDir, shotName);
  await writeFile(dest, downscalePng(stitchPngSideBySide(threeBuf, mapBuf), 720));
  compressPngFile(dest);
});
