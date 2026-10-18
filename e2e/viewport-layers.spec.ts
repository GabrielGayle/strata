import { test, expect } from '@playwright/test';
import { openApp } from './map-helpers';

function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

test('layer toolbar is one row and clear of the caption at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await page.locator('.ws-tabs').getByRole('tab', { name: '3D' }).click();
  const toolbar = page.getByTestId('viewport-layers');
  const caption = page.locator('.overlay.bl.info');
  await expect(toolbar).toBeVisible();
  await expect(caption).toBeVisible();
  const tb = await toolbar.boundingBox();
  const cap = await caption.boundingBox();
  expect(tb).toBeTruthy();
  expect(cap).toBeTruthy();
  expect(tb!.height, 'toolbar should stay on one row').toBeLessThan(40);
  expect(overlap(tb!, cap!), 'toolbar must not cover the bottom-left caption').toBe(false);
  const buttons = toolbar.getByRole('button');
  await expect(buttons).toHaveCount(8);
  const ys = [];
  for (const btn of await buttons.all()) {
    const box = await btn.boundingBox();
    expect(box).toBeTruthy();
    ys.push(Math.round(box!.y));
  }
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4);
  await expect(toolbar.getByRole('button', { name: 'Fin' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Backing' })).toHaveCount(0);
});

test('Vermilion fin has its own toggle; hiding plates does not hide it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await page.locator('.ws-tabs').getByRole('tab', { name: '3D' }).click();
  const toolbar = page.getByTestId('viewport-layers');
  const plates = toolbar.getByRole('button', { name: 'Plates' });
  const fin = toolbar.getByRole('button', { name: 'Fin' });
  await expect(plates).toHaveClass(/on/);
  await expect(fin).toHaveClass(/on/);
  await plates.click();
  await expect(plates).not.toHaveClass(/on/);
  await expect(fin).toHaveClass(/on/);
  await fin.click();
  await expect(fin).not.toHaveClass(/on/);
});

test('edge view aids sit above the layer toolbar and remember their settings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await page.locator('.ws-tabs').getByRole('tab', { name: '3D' }).click();
  const aids = page.getByTestId('view-aids');
  const layers = page.getByTestId('viewport-layers');
  await expect(aids).toBeVisible();
  const a = await aids.boundingBox();
  const l = await layers.boundingBox();
  expect(overlap(a!, l!), 'view aids must not cover the layer toggles').toBe(false);
  const edges = page.getByTestId('view-aid-outlines');
  await expect(edges).not.toHaveClass(/on/);
  await edges.click();
  await expect(edges).toHaveClass(/on/);
  await page.getByTestId('view-aid-tint').selectOption('alternate');
  await page.getByTestId('view-aid-spread').selectOption('2');
  await page.reload();
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await page.locator('.ws-tabs').getByRole('tab', { name: '3D' }).click();
  await expect(page.getByTestId('view-aid-outlines')).toHaveClass(/on/);
  await expect(page.getByTestId('view-aid-tint')).toHaveValue('alternate');
  await expect(page.getByTestId('view-aid-spread')).toHaveValue('2');
});
