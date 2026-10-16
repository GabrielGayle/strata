import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHOT = join(process.cwd(), 'docs/screenshots/viewport');
const FRAMES = join(SHOT, 'frames');

type Churn = { rendererCreated: number; geometryCreated: number; geometryReused: number };

async function skipTour(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('strata:tour-seen', '1');
  });
}

async function waitForApp(page: Page) {
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('.prow').length > 0, { timeout: 60_000 });
}

async function waitForViewport(page: Page) {
  await page.waitForSelector('[data-testid="viewport-3d"] canvas', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="viewport-3d"] canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 8 && c.height > 8;
  }, { timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as { __STRATA_VIEWPORT_CHURN?: Churn }).__STRATA_VIEWPORT_CHURN?.rendererCreated >= 1, { timeout: 30_000 });
}

async function waitChurnStable(page: Page): Promise<Churn> {
  let last = -1;
  for (let i = 0; i < 25; i++) {
    const c = await churn(page);
    if (c.geometryCreated === last && c.rendererCreated === 1) return c;
    last = c.geometryCreated;
    await page.waitForTimeout(200);
  }
  return churn(page);
}

async function churn(page: Page): Promise<Churn> {
  return page.evaluate(() => {
    const c = (window as unknown as { __STRATA_VIEWPORT_CHURN?: Churn }).__STRATA_VIEWPORT_CHURN;
    return { rendererCreated: c?.rendererCreated ?? 0, geometryCreated: c?.geometryCreated ?? 0, geometryReused: c?.geometryReused ?? 0 };
  });
}

async function loadPreset(page: Page, name: string) {
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.status-bar-field').first()).toContainText(/\d+\s+parts/, { timeout: 30_000 });
}

async function gotoTab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click();
}

async function captureCanvas(page: Page, path: string) {
  const canvas = page.locator('[data-testid="viewport-3d"] canvas');
  await canvas.screenshot({ path });
}

async function frameSequence(page: Page, dir: string, n: number, gapMs: number) {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 1; i <= n; i++) {
    const file = join(dir, `${String(i).padStart(2, '0')}.png`);
    await captureCanvas(page, file);
    files.push(file);
    if (i < n) await page.waitForTimeout(gapMs);
  }
  return files;
}

test('3D viewport does not recreate the renderer or geometry on UI churn', async ({ page }) => {
  await mkdir(SHOT, { recursive: true });
  await mkdir(FRAMES, { recursive: true });
  await skipTour(page);
  await page.goto('/');
  await waitForApp(page);
  await waitForViewport(page);

  await loadPreset(page, 'Image cliff');
  await gotoTab(page, '3D');
  await waitForViewport(page);
  await expect(page.locator('.status-bar')).not.toContainText('updating checks', { timeout: 30_000 });
  const before = await waitChurnStable(page);
  await captureCanvas(page, join(SHOT, 'image-cliff-3d.png'));
  expect(before.rendererCreated).toBe(1);
  expect(before.geometryCreated).toBeGreaterThan(0);

  await page.getByRole('button', { name: /X-ray concrete/ }).click();
  await page.getByRole('button', { name: /^Ortho/ }).click();
  await page.getByRole('button', { name: /^Iso/ }).click();
  await page.getByRole('button', { name: /^Front/ }).click();
  await page.getByRole('button', { name: /^Iso/ }).click();
  await page.getByRole('button', { name: /^Ortho/ }).click();
  await page.getByRole('button', { name: /X-ray concrete/ }).click();

  await gotoTab(page, 'Plates');
  await expect(page.locator('.split, .plates, .svgwrap').first()).toBeVisible({ timeout: 15_000 });
  await gotoTab(page, '3D');
  await waitForViewport(page);
  await page.waitForTimeout(200);

  const afterUi = await churn(page);
  expect(afterUi.rendererCreated, 'tab switches and overlay toggles must not rebuild WebGL').toBe(1);
  expect(afterUi.geometryCreated, 'UI that does not change the cut must not rebuild plate buffers').toBe(before.geometryCreated);

  await captureCanvas(page, join(SHOT, 'image-cliff-after-tabs.png'));
  await frameSequence(page, join(FRAMES, 'idle'), 8, 40);

  const slider = page.getByLabel('Master size');
  await slider.waitFor({ state: 'visible' });
  const box = await slider.boundingBox();
  expect(box).toBeTruthy();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + box!.width * 0.35, y);
  await page.mouse.down();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(box!.x + box!.width * (0.35 + i * 0.04), y);
    await captureCanvas(page, join(FRAMES, `drag-${String(i + 1).padStart(2, '0')}.png`));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  const afterDrag = await churn(page);
  expect(afterDrag.rendererCreated).toBe(1);
  expect(afterDrag.geometryCreated).toBeGreaterThanOrEqual(before.geometryCreated);

  await captureCanvas(page, join(SHOT, 'image-cliff-after-slider.png'));

  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input');
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.status-bar')).toContainText(/ready/i, { timeout: 120_000 });
  await gotoTab(page, '3D');
  await waitForViewport(page);
  await expect(page.locator('.status-bar')).not.toContainText('updating checks', { timeout: 60_000 });
  await waitChurnStable(page);
  await captureCanvas(page, join(SHOT, 'neasden-3d.png'));

  const afterMap = await churn(page);
  expect(afterMap.rendererCreated).toBe(1);

  await gotoTab(page, 'Plates');
  await gotoTab(page, '3D');
  await waitForViewport(page);
  expect((await churn(page)).rendererCreated).toBe(1);
  await captureCanvas(page, join(SHOT, 'neasden-after-tabs.png'));
  await frameSequence(page, join(FRAMES, 'neasden-idle'), 6, 40);

  const report = {
    imageCliff: { before, afterUi, afterDrag },
    neasden: afterMap,
  };
  await writeFile(join(SHOT, 'churn.json'), JSON.stringify(report, null, 2));
});
