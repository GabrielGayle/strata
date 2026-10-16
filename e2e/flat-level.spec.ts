import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SHOT = join(process.cwd(), 'docs/screenshots/flat-level');

function u16(metres: (number | null)[], lo: number, hi: number): string {
  const b = new Uint8Array(metres.length * 2);
  metres.forEach((m, i) => {
    const q = m === null ? 0 : 1 + Math.round(((m - lo) / (hi - lo)) * 65534);
    b[i * 2] = q & 255;
    b[i * 2 + 1] = q >> 8;
  });
  return btoa(String.fromCharCode(...b));
}

function depthProject() {
  const w = 16;
  const h = 16;
  const metres: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      metres.push(Math.hypot(x - 7.5, y - 7.5) < 5 ? 1.2 : 8);
    }
  }
  const depth = {
    w,
    h,
    minM: 1,
    maxM: 10,
    nearM: 1,
    farM: 10,
    data: u16(metres, 1, 10),
    settings: {
      near: 1,
      far: 10,
      spacing: 'linear',
      curve: 1,
      flatten: 0,
      matte: false,
      resolution: 256,
      invert: true,
    },
  };
  return JSON.stringify({
    format: 'strata-project',
    version: 1,
    name: 'Flat level',
    params: {
      imgSideMode: 'heightmap',
      imgMix: '1',
      imgRange: '160',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
      banding: '0',
      insShape: 'none',
      plateCount: '12',
      thickness: '3',
      stackHeight: '80',
      baseLength: '220',
      baseWidth: '90',
    },
    images: {
      side: { name: 'depth-side', dataUrl: PNG, depth },
    },
  });
}

async function seed(page: Page, colorScheme: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ({ project, colorScheme }) => {
      localStorage.setItem('strata:tour-seen', '1');
      localStorage.setItem('strata.project.v1', project);
      localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: { Image: false }, ortho: true }));
      localStorage.setItem('strata.theme.v1', JSON.stringify({ id: 'system' }));
      document.documentElement.style.colorScheme = colorScheme;
    },
    { project: depthProject(), colorScheme },
  );
}

async function waitReady(page: Page) {
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await expect(page.locator('.status-bar-field').first()).toContainText(/\d+\s+parts/, { timeout: 60_000 });
  await expect(page.getByTestId('plate-height-range')).toBeVisible({ timeout: 60_000 });
}

async function openTab(page: Page, name: string) {
  await page.locator('.ws-tabs').getByRole('tab', { name }).click();
}

async function setFlatLevelNear(page: Page) {
  const slider = page.getByRole('slider', { name: 'Flat level' });
  await expect(slider).toBeVisible({ timeout: 30_000 });
  await slider.fill('0');
  await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByTestId('flat-plate')).toHaveAttribute('data-override', '1', { timeout: 10_000 });
}

function parseRange(text: string | null) {
  const m = text?.match(/(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)/);
  return m ? { lo: Number(m[1]), hi: Number(m[2]) } : { lo: 0, hi: 0 };
}

test.describe('flat level', () => {
  test('sets Flat level, changes plates, and persists (light + screenshots)', async ({ page }, testInfo) => {
    await mkdir(SHOT, { recursive: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await seed(page, 'light');
    await page.goto('/');
    await waitReady(page);

    await page.locator('.view').screenshot({ path: join(SHOT, '3d-before-light.png') });
    const before = parseRange(await page.getByTestId('plate-height-range').textContent());
    expect(before.hi).toBeGreaterThan(before.lo);

    await openTab(page, 'Image / Graphic');
    await expect(page.getByTestId('flat-plate')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('flat-plate').screenshot({ path: join(SHOT, 'controls-before-light.png') });

    await setFlatLevelNear(page);
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toBeVisible();
    await page.getByTestId('flat-plate').screenshot({ path: join(SHOT, 'controls-after-light.png') });

    await openTab(page, '3D');
    await expect(page.getByTestId('plate-height-range')).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => parseRange(await page.getByTestId('plate-height-range').textContent()), { timeout: 30_000 })
      .not.toEqual(before);
    const after = parseRange(await page.getByTestId('plate-height-range').textContent());
    expect(after.lo !== before.lo || after.hi !== before.hi).toBe(true);
    await page.locator('.view').screenshot({ path: join(SHOT, '3d-after-light.png') });

    await page.waitForTimeout(1800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitReady(page);
    await openTab(page, 'Image / Graphic');
    await expect(page.getByTestId('flat-plate')).toHaveAttribute('data-override', '1', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toBeVisible();
    await openTab(page, '3D');
    const persisted = parseRange(await page.getByTestId('plate-height-range').textContent());
    expect(persisted).toEqual(after);
    testInfo.annotations.push({ type: 'note', description: `plate height before ${before.lo}–${before.hi} after ${after.lo}–${after.hi}` });
  });

  test('dark theme 3D before/after and controls screenshots', async ({ page }) => {
    await mkdir(SHOT, { recursive: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await seed(page, 'dark');
    await page.goto('/');
    await waitReady(page);
    await page.locator('.view').screenshot({ path: join(SHOT, '3d-before-dark.png') });

    await openTab(page, 'Image / Graphic');
    await expect(page.getByTestId('flat-plate')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('flat-plate').screenshot({ path: join(SHOT, 'controls-before-dark.png') });
    await setFlatLevelNear(page);
    await page.getByTestId('flat-plate').screenshot({ path: join(SHOT, 'controls-after-dark.png') });

    await openTab(page, '3D');
    await expect.poll(async () => (await page.getByTestId('plate-height-range').textContent()) ?? '', { timeout: 30_000 }).toMatch(/plate height/);
    await page.waitForTimeout(800);
    await page.locator('.view').screenshot({ path: join(SHOT, '3d-after-dark.png') });
  });
});
