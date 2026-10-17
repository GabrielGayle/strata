import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openApp,
  openWorkspaceTab,
  pickNeasdenPreset,
  assertMapPreviewNonUniform,
  assertPlateHeightMatchesRelief,
  setThemePreset,
  waitForViewportRelief,
  waitForThemeMode,
  waitForPlatesView,
  waitForMapReady,
} from './map-helpers';

async function assertNoThin2mmWarnings(page: import('@playwright/test').Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  await expect(page.locator('.issue').filter({ hasText: /narrower than 2 mm/ })).toHaveCount(0);
}

async function assertZeroFitErrors(page: import('@playwright/test').Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  await expect(page.locator('.status-bar-field').filter({ hasText: /errors/ })).toHaveText('0 errors');
}

test('neasden map plates follow real elevation × exaggeration (fixture)', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);

  const partsText = await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent();
  const parts = Number(partsText?.match(/(\d+)\s+parts/)?.[1] ?? 0);
  expect(parts).toBeGreaterThan(4);

  await assertPlateHeightMatchesRelief(page, 0.3);
  await assertNoThin2mmWarnings(page);
  await assertZeroFitErrors(page);
  await openWorkspaceTab(page, '3D');
  const caption = (await page.getByTestId('plate-height-range').textContent())?.trim() ?? '';
  expect(caption).toMatch(/terrain \d+[–-]\d+ mm/);

  await openWorkspaceTab(page, 'Map');
  await expect(page.locator('.map-view h2')).toBeVisible();
  await expect(page.getByTestId('map-readout')).toContainText(caption);
  await expect(page.getByTestId('sunken-frame-checkbox')).toBeDisabled();
  await expect(page.locator('#map-sunken-frame-hint')).toContainText(/Stamped stack \(flat layers\)/);
  const dtm = page.locator('#map-model-dtm');
  await expect(dtm).toBeChecked();
  await expect.poll(async () => dtm.evaluate((el) => el.nextElementSibling?.getAttribute('for'))).toBe('map-model-dtm');
  await expect(page.locator('label[for="map-model-dtm"]')).toBeVisible();
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  await assertMapPreviewNonUniform(page);

  await mkdir(join(process.cwd(), 'docs/screenshots'), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), 'docs/screenshots/neasden-map-3d.png'), fullPage: false });
  await page.getByTestId('sunken-frame-checkbox').scrollIntoViewIfNeeded();
  await page.locator('.map-view').screenshot({ path: join(process.cwd(), 'docs/screenshots/map-tab.png') });
});

test('Stamped stack map readout matches stack height; sunken frame is enabled', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Presets ▾' }).click();
  await page.locator('.menu-pop').getByRole('button', { name: /Stamped stack/ }).click();
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, '3D');
  const caption = (await page.getByTestId('plate-height-range').textContent())?.trim() ?? '';
  expect(caption).toMatch(/stack height \d+ mm/);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByTestId('map-readout')).toContainText(caption);
  await expect(page.getByTestId('sunken-frame-checkbox')).toBeEnabled();
  await expect(page.locator('#map-sunken-frame-hint')).toHaveCount(0);
});

test('re-clicking Neasden keeps user vertical exaggeration ×21', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByLabel('Vertical exaggeration').selectOption('21');
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await page.getByRole('button', { name: 'Maps ▾' }).click();
  await page.locator('.menu-pop').getByRole('button', { name: /^Neasden\b/ }).first().click();
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await page.locator('.map-preset-row').getByRole('button', { name: 'Neasden', exact: true }).click();
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
});

test('neasden ×11 and ×21 have no 2 mm thin-neck fit warnings', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  for (const ex of ['11', '21']) {
    await page.getByLabel('Vertical exaggeration').selectOption(ex);
    await waitForMapReady(page);
    await assertNoThin2mmWarnings(page);
    await assertZeroFitErrors(page);
  }
});

test('stamped stack + neasden ×11 and ×21 have no fit errors', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: /Stamped stack/ }).click();
  await expect(page.locator('.status-bar-field').filter({ hasText: /parts/ })).toContainText(/\d+\s+parts/, { timeout: 90_000 });
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  for (const ex of ['11', '21']) {
    await page.getByLabel('Vertical exaggeration').selectOption(ex);
    await waitForMapReady(page);
    await assertZeroFitErrors(page);
    await assertNoThin2mmWarnings(page);
  }
});

test('stamped Neasden ×11 vs ×21: stack is n×thickness; exaggeration still changes the wanted millimetres', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: /Stamped stack/ }).click();
  await expect(page.locator('.status-bar-field').filter({ hasText: /parts/ })).toContainText(/\d+\s+parts/, { timeout: 90_000 });
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');

  const read = async (ex: '11' | '21') => {
    await page.getByLabel('Vertical exaggeration').selectOption(ex);
    await waitForMapReady(page);
    await openWorkspaceTab(page, '3D');
    const caption = (await page.getByTestId('plate-height-range').textContent())?.trim() ?? '';
    const root = page.locator('.app.window');
    return {
      caption,
      factor: Number(await root.getAttribute('data-strata-map-exaggeration')),
      stackMm: Number(await root.getAttribute('data-strata-plate-height-range-mm')),
      wantedMm: Number(await root.getAttribute('data-strata-map-expected-height-mm')),
      terrainTopMm: Number(await root.getAttribute('data-strata-map-terrain-top-mm')),
      capped: await root.getAttribute('data-strata-map-stack-capped'),
    };
  };

  const a = await read('11');
  const b = await read('21');
  expect(a.factor).toBe(11);
  expect(b.factor).toBe(21);
  expect(a.stackMm).toBeGreaterThan(0);
  expect(b.stackMm).toBe(a.stackMm);
  expect(b.wantedMm / a.wantedMm).toBeGreaterThan(1.6);
  expect(b.wantedMm / a.wantedMm).toBeLessThan(2.2);
  expect(a.caption).toMatch(/stack height \d+ mm/);
  expect(b.caption).toMatch(/stack height \d+ mm/);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByTestId('map-readout')).toContainText(b.caption);
  if (a.terrainTopMm > a.stackMm + 3) {
    expect(a.capped).toBe('1');
    expect(a.caption).toMatch(/capped at \d+ layers/);
  }
  if (b.terrainTopMm > b.stackMm + 3) {
    expect(b.capped).toBe('1');
    expect(b.caption).toMatch(/capped at \d+ layers/);
  }
});

test('neasden 3D and Plates screenshots in light and dark', async ({ page }) => {
  await openApp(page);
  await pickNeasdenPreset(page);
  await waitForViewportRelief(page);

  const shotDir = join(process.cwd(), 'docs/screenshots/map-p0');
  await mkdir(shotDir, { recursive: true });

  for (const { theme, prefix, mode } of [
    { theme: 'Paper', prefix: 'light', mode: 'light' as const },
    { theme: 'Ink', prefix: 'dark', mode: 'dark' as const },
  ]) {
    await setThemePreset(page, theme);
    await waitForThemeMode(page, mode);
    await openWorkspaceTab(page, '3D');
    await expect(page.locator('.main canvas').first()).toBeVisible();
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-3d.png`) });
    await waitForPlatesView(page);
    await page.locator('.main').screenshot({ path: join(shotDir, `${prefix}-plates.png`) });
  }
});
