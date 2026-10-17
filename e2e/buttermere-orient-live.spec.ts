import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  applyMapBbox,
  setBaseSizeMm,
  assertZeroFitErrors,
  clickQuickMap,
  compressPngFile,
  downscalePng,
  scalePngToHeight,
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
const isBefore = process.env.BUTTERMERE_ORIENT_SHOT === 'before';
const shotName = isBefore ? 'orient-before.png' : 'orient-after.png';

test('live Buttermere 500×500: 3D Top north matches Map preview', async ({ page }) => {
  test.setTimeout(420_000);
  await mkdir(shotDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await setBaseSizeMm(page, 500, 500);
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await clickQuickMap(page);
  await waitForMapReady(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByLabel('Vertical exaggeration').selectOption('4');
  await waitForMapReady(page);
  if (!isBefore) await assertZeroFitErrors(page);

  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-phase', 'ready');
  await expect(page.locator('.overlay.bl.info')).toContainText(/500\s*×\s*500/);
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  await expect(page.getByLabel('OSM engrave on top face')).toBeChecked();

  await snapViewportDir(page, 'top', true);
  await waitForViewportRelief(page);
  const top3d = page.getByTestId('viewport-3d');
  await expect(top3d.getByRole('button', { name: 'Top' })).toHaveClass(/on/);
  await expect(page.getByTestId('plate-height-range')).toContainText(/terrain/i);
  const waterBtn = top3d.getByRole('button', { name: 'Water' });
  if (!(await waterBtn.getAttribute('class'))?.includes('on')) await waterBtn.click();
  await page.waitForTimeout(1500);
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
  const mapBuf = Buffer.from(await page.locator('.map-preview-pane').screenshot({ type: 'png' }));
  const dest = join(shotDir, shotName);
  await writeFile(dest, downscalePng(stitchPngSideBySide(threeBuf, scalePngToHeight(mapBuf, PNG.sync.read(threeBuf).height)), 720));
  compressPngFile(dest);

  if (!isBefore) {
    await snapViewportDir(page, 'front', true);
    await waitForViewportRelief(page);
    const front3d = page.getByTestId('viewport-3d');
    await expect(front3d.getByRole('button', { name: 'Front' })).toHaveClass(/on/);
    const frontDest = join(shotDir, 'orient-front.png');
    const frontBuf = Buffer.from(await front3d.screenshot({ type: 'png' }));
    await writeFile(frontDest, downscalePng(frontBuf, 720));
    compressPngFile(frontDest);
  }
});
