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
  await expect(buttons).toHaveCount(9);
  const ys = [];
  for (const btn of await buttons.all()) {
    const box = await btn.boundingBox();
    expect(box).toBeTruthy();
    ys.push(Math.round(box!.y));
  }
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4);
});
