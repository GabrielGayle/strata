import { test, expect } from '@playwright/test';

test('orbiting does not remount the 3D scene', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('strata:tour-seen', '1');
  });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 120_000 });
  await page.waitForSelector('.ws-area canvas', { timeout: 120_000 });
  await page.waitForFunction(() => ((window as Window & { __STRATA_SCENE_MOUNT_COUNT?: number }).__STRATA_SCENE_MOUNT_COUNT ?? 0) >= 1, {
    timeout: 120_000,
  });

  const mountsBefore = await page.evaluate(() => (window as Window & { __STRATA_SCENE_MOUNT_COUNT?: number }).__STRATA_SCENE_MOUNT_COUNT ?? 0);
  expect(mountsBefore).toBeGreaterThanOrEqual(1);

  const canvas = page.locator('.ws-area canvas').first();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const cx = box!.x + box!.width * 0.55;
  const cy = box!.y + box!.height * 0.5;

  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  const mountsAfter = await page.evaluate(() => (window as Window & { __STRATA_SCENE_MOUNT_COUNT?: number }).__STRATA_SCENE_MOUNT_COUNT ?? 0);
  expect(mountsAfter).toBe(mountsBefore);
});
