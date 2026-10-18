import { test, expect } from '@playwright/test';
import {
  assertNoThin2mmWarnings,
  assertZeroFitErrors,
  clickQuickMap,
  openApp,
  openWorkspaceTab,
  pickNeasdenPreset,
  waitForMapReady,
} from './map-helpers';

test('Quick map lives in the Map tab and both Maps menus', async ({ page }) => {
  await openApp(page);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByTestId('quick-map')).toBeVisible();

  await page.getByRole('button', { name: 'Maps ▾' }).click();
  await expect(page.getByTestId('quick-map-from-maps')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Presets ▾' }).click();
  await expect(page.getByTestId('quick-map-from-presets')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Quick map sets display options, keeps ×21, undoes in one step', async ({ page }) => {
  test.setTimeout(360_000);
  await openApp(page);
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');

  await page.getByLabel('Vertical exaggeration').selectOption('21');
  await waitForMapReady(page);
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await expect(page.getByLabel('Preset & font pairing')).toHaveValue('city');
  const beforeCount = await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent();

  await clickQuickMap(page);
  await waitForMapReady(page);

  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await expect(page.getByLabel('Preset & font pairing')).toHaveValue('survey');
  await expect(page.getByTestId('map-engrave-labels')).toBeChecked();
  await expect(page.locator('#map-water-flat')).toBeChecked();
  await expect(page.locator('#map-model-dtm')).toBeChecked();
  await expect(page.getByLabel('OSM engrave on top face')).toBeChecked();

  await assertZeroFitErrors(page);
  await assertNoThin2mmWarnings(page);

  await openWorkspaceTab(page, '3D');
  await expect(page.getByTestId('viewport-layers').getByRole('button', { name: 'Fin' })).not.toHaveClass(/on/);
  await expect(page.getByTestId('viewport-layers').getByRole('button', { name: 'Labels / dims' })).toHaveClass(/on/);
  await expect(page.getByTestId('viewport-layers').getByRole('button', { name: 'Engrave / OSM' })).toHaveClass(/on/);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await waitForMapReady(page);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('21');
  await expect(page.getByLabel('Preset & font pairing')).toHaveValue('city');
  const afterUndo = await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent();
  expect(afterUndo).toBe(beforeCount);
});
