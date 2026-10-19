import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openApp, pickNeasdenPreset, assertZeroFitErrors, waitForModelCurrent, snapViewportDir, dismissTour } from './map-helpers';

const OUT = join(process.cwd(), 'docs/screenshots/waffle-grid');

async function slicer(page: Page) {
  const g = page.locator('[data-group="Slicer"]');
  const head = g.locator('button.section-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  return g;
}

async function setNum(page: Page, label: string, value: string) {
  const g = await slicer(page);
  const plain = g.getByLabel(`${label} value`, { exact: true });
  const box = (await plain.count()) ? plain : g.getByLabel(`${label} expression`, { exact: true });
  await box.fill(value);
  await box.press('Enter');
  await box.blur();
}

async function closedGrid(page: Page, cell: string) {
  const g = await slicer(page);
  await g.getByLabel('Slicing', { exact: true }).selectOption('waffle');
  await g.getByLabel('Cross plate layout', { exact: true }).selectOption('grid');
  await setNum(page, 'Cell size', cell);
  await waitForModelCurrent(page);
}

async function shot(page: Page, name: string) {
  await waitForModelCurrent(page);
  await page.waitForTimeout(1_500);
  await page.getByTestId('viewport-3d').screenshot({ path: join(OUT, `${name}.png`) });
}

test('Neasden map: closed square grid, then the two blocks slanted at 60°', async ({ page }) => {
  await mkdir(OUT, { recursive: true });
  await openApp(page);
  await pickNeasdenPreset(page);
  await closedGrid(page, '40');
  await assertZeroFitErrors(page);
  await snapViewportDir(page, 'iso', false);
  await shot(page, 'map-square-iso');
  // the closed frame slants too: on this long base it only fits a diamond patch
  await setNum(page, 'Cross plate angle', '60');
  await assertZeroFitErrors(page);
  await snapViewportDir(page, 'iso', false);
  await shot(page, 'map-diamond-iso');
  // without the frame the slanted cross plates run corner to corner through the whole stack
  await (await slicer(page)).getByLabel('Cross plate layout', { exact: true }).selectOption('spread');
  await assertZeroFitErrors(page);
  await snapViewportDir(page, 'iso', false);
  await shot(page, 'map-slanted-spread-iso');
  await snapViewportDir(page, 'top');
  await shot(page, 'map-slanted-spread-top');
});

test('Stamped stack design: rectangles, then diamonds', async ({ page }) => {
  await mkdir(OUT, { recursive: true });
  await openApp(page);
  await dismissTour(page);
  await page.getByRole('button', { name: 'Presets ▾' }).click();
  await page.locator('.menu-pop').getByRole('button', { name: /^Stamped stack\b/ }).first().click();
  await waitForModelCurrent(page);
  await snapViewportDir(page, 'iso', false);
  await shot(page, 'stamped-before');
  await closedGrid(page, '40');
  const g = await slicer(page);
  await g.getByLabel('Cell shape', { exact: true }).selectOption('rect');
  await setNum(page, 'Cross cell size', '70');
  await assertZeroFitErrors(page);
  await snapViewportDir(page, 'iso', false);
  await shot(page, 'stamped-rect-iso');
  await snapViewportDir(page, 'top');
  await shot(page, 'stamped-rect-top');
  await g.getByLabel('Cell shape', { exact: true }).selectOption('square');
  await setNum(page, 'Cell size', '30');
  await setNum(page, 'Cross plate angle', '60');
  await assertZeroFitErrors(page);
  await snapViewportDir(page, 'iso', false);
  await shot(page, 'stamped-diamond-iso');
  await snapViewportDir(page, 'top');
  await shot(page, 'stamped-diamond-top');
});
