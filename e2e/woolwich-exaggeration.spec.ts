import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { openWorkspaceTab, snapViewportDir, waitForMapReady } from './map-helpers';

const root = fileURLToPath(new URL('..', import.meta.url));
const projectJson = readFileSync(join(root, 'test/fixtures/projects/woolwich-exaggeration.strata.json'), 'utf8');
const shotDir = join(root, 'docs/screenshots/woolwich');
const artifactDir = '/opt/cursor/artifacts/screenshots';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((json) => {
    localStorage.setItem('strata:tour-seen', '1');
    localStorage.setItem('strata.project.v1', json);
    localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: {}, ortho: true }));
  }, projectJson);
});

async function shot(page: import('@playwright/test').Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  const view = page.locator('.main').first();
  await view.screenshot({ path: join(shotDir, `${name}.png`) });
  await view.screenshot({ path: join(artifactDir, `${name}.png`) });
}

test('Woolwich fixture: auto rebuild, set ×1.5, export keeps 46 plates', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await waitForMapReady(page);

  await openWorkspaceTab(page, 'Map');
  const select = page.getByLabel('Vertical exaggeration');
  await expect(select).toHaveValue('auto');
  const readout = page.getByTestId('map-readout');
  await expect(readout).toContainText(/×[123](\.\d)?/);

  await snapViewportDir(page, 'iso', true);
  await shot(page, 'woolwich-auto');

  await openWorkspaceTab(page, 'Map');
  await select.selectOption('1.5');
  await expect(select).toHaveValue('1.5');
  await expect(page.getByTestId('map-exaggeration-slider')).toHaveValue('1.5');
  await expect(page.getByTestId('map-exaggeration-input')).toHaveValue('1.5');
  await waitForMapReady(page);
  await expect(page.getByTestId('map-readout')).toContainText('×1.5');

  const rootEl = page.locator('.app.window');
  await expect.poll(async () => Number(await rootEl.getAttribute('data-strata-map-exaggeration'))).toBe(1.5);

  await snapViewportDir(page, 'iso', true);
  await shot(page, 'woolwich-1.5');

  await expect(page.getByLabel('Plate count value')).toHaveValue('46');
  const inApp = Number(await page.locator('[data-in-app-plates]').getAttribute('data-in-app-plates'));
  expect(inApp).toBe(46);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const fail = await download.failure();
  expect(fail).toBeNull();
  const buf = readFileSync((await download.path())!);
  const files = unzipSync(new Uint8Array(buf));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  const plateDxf = Object.keys(files).filter((n) => n.startsWith('plates/') && n.endsWith('.dxf')).length;
  expect(manifest.plateCount).toBe(46);
  expect(plateDxf).toBe(46);
});
