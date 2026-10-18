/**
 * View from point — Google Earth URL → 3D camera.
 *
 * Unique port, never reuse a leftover preview:
 *   CI=1 STRATA_E2E_PORT=<free> npx playwright test e2e/view-from-point.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openApp, openWorkspaceTab } from './map-helpers';

const WOOLWICH =
  'https://earth.google.com/web/search/Woolwich,+London/@51.48946601,0.06689012,19.6383861a,192.84630668d,35y,-75.96181029h,72.70188718t,0r';
const CHARLTON = '@51.48171239,0.04793208,43a,5168.7d,35y,-124.30h,85.33t';

const artifactDir = '/tmp/cursor/artifacts';

type PointWin = Window & {
  __STRATA_POINT_VIEW__?: {
    position: [number, number, number];
    target: [number, number, number];
    look: { x: number; y: number; z: number };
    fov: number;
    applied?: boolean;
  };
};

async function shot(page: Page, name: string) {
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined);
  const panel = page.getByTestId('view-from-point');
  const panelOpen = await panel.isVisible();
  if (panelOpen) {
    await page.getByTestId('view-from-point-toggle').click();
    await expect(panel).toBeHidden();
  }
  await page.waitForTimeout(500);
  const canvas = page.locator('[data-testid="viewport-3d"] canvas').first();
  await canvas.screenshot({ path: join(artifactDir, `${name}.png`) });
  if (panelOpen) {
    await page.getByTestId('view-from-point-toggle').click();
    await expect(panel).toBeVisible();
  }
}

async function openPointPanel(page: Page) {
  await openWorkspaceTab(page, '3D');
  await page.getByTestId('view-from-point-toggle').click();
  await expect(page.getByTestId('view-from-point')).toBeVisible();
}

async function lookFrom(page: Page, text: string) {
  const box = page.getByTestId('view-from-point-input');
  await box.fill(text);
  await box.blur();
  await page.getByTestId('view-from-point-look').click();
}

async function pointView(page: Page) {
  return page.evaluate(() => (window as PointWin).__STRATA_POINT_VIEW__ ?? null);
}

async function waitApplied(page: Page) {
  await expect
    .poll(async () => {
      const v = await pointView(page);
      return v?.applied ? v.fov : 0;
    })
    .toBeCloseTo(35, 0);
}

test('View from point: Woolwich URL, fit box, Charlton URL, saved view round-trip', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('dialog', () => {
    throw new Error('View from point must not call alert()');
  });
  await openApp(page);
  await page.waitForSelector('[data-testid="viewport-3d"] canvas', { timeout: 120_000 });
  await openPointPanel(page);

  await page.locator('.overlay.tr').getByRole('button', { name: /^Objects/ }).click();
  await expect(page.locator('.overlay.appearance.objects')).toBeVisible();
  const lookBtn = page.getByTestId('view-from-point-look');
  await expect(lookBtn).toBeVisible();
  await lookBtn.click({ trial: true });
  await lookFrom(page, WOOLWICH);
  await expect(page.getByTestId('view-from-point-warning')).toBeVisible();
  await page.locator('.overlay.tr').getByRole('button', { name: /^Objects/ }).click();
  await expect(page.locator('.overlay.appearance.objects')).toHaveCount(0);

  await lookFrom(page, 'not a google earth view');
  await expect(page.getByTestId('view-from-point-warning')).toContainText(/Paste a Google Earth|Could not read|lat, lon/i);

  await lookFrom(page, WOOLWICH);
  const warn = page.getByTestId('view-from-point-warning');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText(/map box/i);

  await expect(page.getByTestId('view-from-point-match-base')).toBeChecked();
  await page.getByTestId('view-from-point-fit').click();
  await waitApplied(page);
  await page.getByTestId('view-from-point-look').click();
  await waitApplied(page);
  await expect(page.getByTestId('view-from-point-warning')).toHaveCount(0);

  const wool = await pointView(page);
  expect(wool).toBeTruthy();
  expect(wool!.look.z, 'WNW look has +Z west').toBeGreaterThan(0);
  expect(wool!.look.x, 'WNW look has −X north').toBeLessThan(0);
  expect(Math.abs(wool!.look.z)).toBeGreaterThan(Math.abs(wool!.look.x) * 0.8);
  expect(wool!.position[1], 'camera sits above the look-at').toBeGreaterThan(wool!.target[1]);
  const horiz = Math.hypot(wool!.look.x, wool!.look.z);
  const tiltDeg = (Math.atan2(horiz, -wool!.look.y) * 180) / Math.PI;
  expect(tiltDeg).toBeCloseTo(72.7, 0);
  const baseLine = await page.locator('.overlay.bl').textContent();
  const dims = baseLine?.match(/base\s+([\d.]+)\s*×\s*([\d.]+)/);
  expect(dims, 'base readout after Match base to map shape').toBeTruthy();
  const baseLength = Number(dims![1]);
  const baseWidth = Number(dims![2]);
  expect(Math.max(baseLength, baseWidth)).toBeCloseTo(800, 0);
  expect(baseWidth, 'E–W side grew to the map aspect').toBeGreaterThan(300);
  await shot(page, 'view-from-point-woolwich');

  await openWorkspaceTab(page, 'Map');
  const west = Number(await page.getByTestId('map-bbox-west').inputValue());
  const south = Number(await page.getByTestId('map-bbox-south').inputValue());
  const east = Number(await page.getByTestId('map-bbox-east').inputValue());
  const north = Number(await page.getByTestId('map-bbox-north').inputValue());
  const camLon = 0.06689012;
  const camLat = 51.48946601;
  expect(west).toBeLessThan(camLon);
  expect(east).toBeGreaterThan(camLon - 0.02);
  expect(north).toBeGreaterThan(camLat - 0.01);
  expect(south).toBeLessThan(camLat + 0.01);
  expect(camLon - west).toBeGreaterThan(east - camLon);

  await openWorkspaceTab(page, '3D');
  await lookFrom(page, CHARLTON);
  const stillOutside = await page.getByTestId('view-from-point-warning').textContent();
  if (stillOutside && /outside/i.test(stillOutside)) {
    await page.getByTestId('view-from-point-fit').click();
  }
  await waitApplied(page);
  const charlton = await pointView(page);
  expect(charlton).toBeTruthy();
  expect(charlton!.look.z).toBeGreaterThan(0);
  await shot(page, 'view-from-point-charlton');

  const localSave = page.locator('.save-mark').filter({ hasText: /Saved|Saving/ }).first();
  await expect(localSave).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => localSave.textContent(), { timeout: 15_000 }).toMatch(/Saved/);

  await page.reload();
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="viewport-3d"] canvas', { timeout: 120_000 });
  await openPointPanel(page);
  await expect(page.getByTestId('view-from-point-return')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByLabel('Latitude')).toHaveValue(/51\.48/);
  await expect(page.getByLabel('Longitude')).toHaveValue(/0\.04/);
  await page.getByTestId('view-from-point-return').click();
  await waitApplied(page);
  const back = await pointView(page);
  expect(back).toBeTruthy();
  expect(back!.look.z).toBeGreaterThan(0);
});
