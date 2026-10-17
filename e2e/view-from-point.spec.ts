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

test('View from point: Woolwich URL, fit box, Charlton URL, saved view round-trip', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('dialog', () => {
    throw new Error('View from point must not call alert()');
  });
  await openApp(page);
  await page.waitForSelector('[data-testid="viewport-3d"] canvas', { timeout: 120_000 });
  await openPointPanel(page);

  await lookFrom(page, 'not a google earth view');
  await expect(page.getByTestId('view-from-point-warning')).toContainText(/Paste a Google Earth|Could not read|lat, lon/i);

  await lookFrom(page, WOOLWICH);
  const warn = page.getByTestId('view-from-point-warning');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText(/map box/i);

  await page.getByTestId('view-from-point-fit').click();
  await expect.poll(async () => (await pointView(page))?.fov ?? 0).toBeCloseTo(35, 0);

  const wool = await pointView(page);
  expect(wool).toBeTruthy();
  expect(wool!.look.z, 'WNW look has +Z west').toBeGreaterThan(0);
  expect(wool!.look.x, 'WNW look has −X north').toBeLessThan(0);
  expect(Math.abs(wool!.look.z)).toBeGreaterThan(Math.abs(wool!.look.x) * 0.8);
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
  await expect.poll(async () => (await pointView(page))?.fov ?? 0).toBeCloseTo(35, 0);
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
  await page.getByTestId('view-from-point-return').click();
  await expect.poll(async () => (await pointView(page))?.fov ?? 0).toBeCloseTo(35, 0);
  const back = await pointView(page);
  expect(back).toBeTruthy();
  expect(back!.look.z).toBeGreaterThan(0);
});
