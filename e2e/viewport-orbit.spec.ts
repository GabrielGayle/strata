import { test, expect, type Page } from '@playwright/test';
import { dismissTour, seedAllTourSeenKeys } from './map-helpers';

type MountWin = Window & { __STRATA_SCENE_MOUNT_COUNT?: number };

async function dismissTourAndWait(page: Page) {
  await page.addInitScript(seedAllTourSeenKeys);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 120_000 });
  await dismissTour(page, { waitMs: 2_000 });
  await page.waitForSelector('[data-testid="viewport-3d"] canvas', { timeout: 120_000 });
  await page.waitForFunction(() => ((window as MountWin).__STRATA_SCENE_MOUNT_COUNT ?? 0) >= 1, {
    timeout: 120_000,
  });
}

function mounts(page: Page) {
  return page.evaluate(() => (window as MountWin).__STRATA_SCENE_MOUNT_COUNT ?? 0);
}

async function openWorkspaceTab(page: Page, name: string | RegExp) {
  await page.locator('.ws-tabs').getByRole('tab', { name }).click();
}

test('orbiting does not remount the 3D scene', async ({ page }) => {
  await dismissTourAndWait(page);

  const mountsBefore = await mounts(page);
  expect(mountsBefore).toBeGreaterThanOrEqual(1);

  const canvas = page.locator('[data-testid="viewport-3d"] canvas').first();
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

  const mountsAfter = await mounts(page);
  expect(mountsAfter).toBe(mountsBefore);
});

test('tab switches and Master size drag keep a single canvas mount', async ({ page }) => {
  await dismissTourAndWait(page);
  const canvas = page.locator('[data-testid="viewport-3d"] canvas').first();
  await expect(canvas).toBeVisible();

  const mountsBefore = await mounts(page);
  expect(mountsBefore).toBeGreaterThanOrEqual(1);
  const canvasNode = await canvas.elementHandle();
  expect(canvasNode).toBeTruthy();

  for (const name of [/^Plates$/, /^Map$/, /^Image \/ Graphic$/, /^3D$/, /^Nest$/, /^3D$/]) {
    await openWorkspaceTab(page, name);
    await page.waitForTimeout(250);
  }

  await expect(canvas).toBeVisible();
  const sameCanvas = await page.evaluate((el) => el != null && el.isConnected && document.querySelector('[data-testid="viewport-3d"] canvas') === el, canvasNode);
  expect(sameCanvas).toBe(true);
  expect(await mounts(page)).toBe(mountsBefore);

  const slider = page.getByRole('slider', { name: 'Master size' });
  await slider.scrollIntoViewIfNeeded();
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  expect(box).toBeTruthy();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + Math.min(24, box!.width * 0.2), y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, y, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(800);

  expect(await mounts(page)).toBe(mountsBefore);
  const stillSame = await page.evaluate((el) => el != null && el.isConnected && document.querySelector('[data-testid="viewport-3d"] canvas') === el, canvasNode);
  expect(stillSame).toBe(true);
});
