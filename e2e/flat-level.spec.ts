import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SHOT = join(process.cwd(), 'docs/screenshots/flat-level');

function u16(metres: number[], lo: number, hi: number): string {
  const b = new Uint8Array(metres.length * 2);
  metres.forEach((m, i) => {
    const q = 1 + Math.round(((m - lo) / (hi - lo)) * 65534);
    b[i * 2] = q & 255;
    b[i * 2 + 1] = q >> 8;
  });
  return btoa(String.fromCharCode(...b));
}

/** Dome 1.5–3 m in front of a 7–9 m backdrop. */
function depthProject() {
  const w = 24;
  const h = 24;
  const metres: number[] = [];
  const cx = 11.5;
  const cy = 11.5;
  const rad = 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - cx, y - cy) / rad;
      metres.push(r < 1 ? 1.5 + r * r * 1.5 : 7 + (2 * ((x + y) % 7)) / 6);
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
      side: { name: 'dome-side', dataUrl: PNG, depth },
    },
  });
}

async function seed(page: Page) {
  await page.addInitScript((project) => {
    localStorage.setItem('strata:tour-seen', '1');
    localStorage.setItem('strata.project.v1', project);
    localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: { Image: false }, ortho: true }));
  }, depthProject());
}

async function waitReady(page: Page) {
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  // Pack integrity puts plate count first; wait on the parts field, not .first().
  await expect(page.getByTestId('status-counts')).toContainText(/\d+\s+parts/, { timeout: 60_000 });
  await expect(page.getByTestId('plate-height-range')).toBeVisible({ timeout: 60_000 });
}

async function openTab(page: Page, name: string) {
  await page.locator('.ws-tabs').getByRole('tab', { name }).click();
}

async function chooseAppearance(page: Page, name: 'Paper' | 'Dusk' | 'Ink') {
  await page.getByRole('button', { name: /^Appearance/ }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme')), { timeout: 10_000 })
    .toBe(name === 'Paper' ? 'light' : 'dark');
}

function parseRange(text: string | null) {
  const m = text?.match(/(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)/);
  return m ? { lo: Number(m[1]), hi: Number(m[2]) } : { lo: 0, hi: 0 };
}

async function plateRange(page: Page) {
  return parseRange(await page.getByTestId('plate-height-range').textContent());
}

async function viewportLum(page: Page) {
  return page.locator('.view').evaluate((el) => {
    const c = getComputedStyle(el).backgroundColor;
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return 0;
    return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
  });
}

async function fieldsetContrast(page: Page) {
  return page.getByTestId('flat-plate').evaluate((el) => {
    const cs = getComputedStyle(el);
    const parse = (value: string) => {
      const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return { r: 0, g: 0, b: 0, a: 1 };
      return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 };
    };
    const lin = (c: number) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const fg = parse(cs.color);
    const bg = parse(cs.backgroundColor);
    const l1 = lum(fg);
    const l2 = lum(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  });
}

async function assertFitsCard(page: Page) {
  const card = page.getByTestId('face-card-side');
  const fieldset = page.getByTestId('flat-plate');
  const box = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  });
  const flat = await fieldset.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, overflow: el.scrollWidth - el.clientWidth };
  });
  expect(flat.overflow).toBeLessThanOrEqual(1);
  expect(flat.left).toBeGreaterThanOrEqual(box.left - 1);
  expect(flat.right).toBeLessThanOrEqual(box.right + 1);
}

/** Mid-ground plate: behind the 1.5–3 m dome, in front of the 7–9 m backdrop. */
async function setFlatLevelMetres(page: Page, metres: number) {
  const slider = page.getByRole('slider', { name: 'Flat level' });
  await expect(slider).toBeVisible();
  const t = Math.round(((Math.log(metres) - Math.log(1)) / (Math.log(10) - Math.log(1))) * 1000);
  await slider.fill(String(t));
  await slider.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(t));
  await expect(page.getByTestId('flat-plate')).toHaveAttribute('data-override', '1', { timeout: 10_000 });
  await expect(page.getByTestId('flat-plate').locator('.mono').first()).toContainText(/5\.0\d* m/);
}

test.describe('flat level', () => {
  test('Off default, Auto keeps the dome and raises the backdrop (Paper + clip)', async ({ page }, testInfo) => {
    await mkdir(SHOT, { recursive: true });
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await waitReady(page);
    await chooseAppearance(page, 'Paper');
    expect(await viewportLum(page)).toBeGreaterThan(140);

    await page.locator('.view').screenshot({ path: join(SHOT, '3d-before-light.png') });
    const before = await plateRange(page);
    expect(before.hi).toBeGreaterThan(before.lo + 20);

    await openTab(page, 'Image / Graphic');
    const plate = page.getByTestId('flat-plate');
    await expect(plate).toBeVisible({ timeout: 30_000 });
    await expect(plate).toHaveAttribute('data-mode', 'off');
    await plate.screenshot({ path: join(SHOT, 'controls-before-light.png') });
    expect(await fieldsetContrast(page)).toBeGreaterThanOrEqual(4.5);
    await assertFitsCard(page);

    await plate.getByRole('button', { name: 'Auto', exact: true }).click();
    await expect(plate).toHaveAttribute('data-mode', 'auto');
    await expect(page.getByRole('slider', { name: 'Flat level' })).toBeVisible();
    await setFlatLevelMetres(page, 5);
    await plate.screenshot({ path: join(SHOT, 'controls-after-light.png') });
    await assertFitsCard(page);

    await openTab(page, '3D');
    await expect
      .poll(async () => plateRange(page), { timeout: 30_000 })
      .not.toEqual(before);
    const after = await plateRange(page);
    expect(after.lo, `min should rise (before ${before.lo}–${before.hi} after ${after.lo}–${after.hi})`).toBeGreaterThan(before.lo + 2);
    expect(after.hi, 'subject peak kept').toBeGreaterThan(before.hi * 0.85);
    expect(after.hi).toBeGreaterThan(after.lo + 15);
    await page.locator('.view').screenshot({ path: join(SHOT, '3d-after-light.png') });

    await page.setViewportSize({ width: 1600, height: 900 });
    await openTab(page, 'Image / Graphic');
    await page.getByTestId('flat-plate').scrollIntoViewIfNeeded();
    await assertFitsCard(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId('flat-plate').scrollIntoViewIfNeeded();
    await assertFitsCard(page);

    await plate.getByRole('slider', { name: 'Edge ease' }).fill('0.4');
    await plate.getByRole('slider', { name: 'Step limit' }).fill('0.1');
    await plate.getByRole('checkbox', { name: 'Flatten the negative side' }).check();
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset to auto' }).click();
    await expect(plate).toHaveAttribute('data-mode', 'auto');
    expect(Number(await plate.getByRole('slider', { name: 'Edge ease' }).inputValue())).toBe(0);
    expect(Number(await plate.getByRole('slider', { name: 'Step limit' }).inputValue())).toBe(0);
    await expect(plate.getByRole('checkbox', { name: 'Flatten the negative side' })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toHaveCount(0);

    await page.waitForTimeout(1800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitReady(page);
    await openTab(page, 'Image / Graphic');
    await expect(page.getByTestId('flat-plate')).toHaveAttribute('data-mode', 'auto', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toHaveCount(0);
    await openTab(page, '3D');
    const persisted = await plateRange(page);
    expect(persisted.hi).toBeGreaterThan(before.hi * 0.85);

    await openTab(page, 'Image / Graphic');
    await page.getByTestId('flat-plate').getByRole('button', { name: 'Off', exact: true }).click();
    await expect(page.getByTestId('flat-plate')).toHaveAttribute('data-mode', 'off');
    await openTab(page, '3D');
    await expect.poll(async () => plateRange(page).then((r) => r.lo), { timeout: 30_000 }).toBeLessThan(after.lo);
    testInfo.annotations.push({ type: 'note', description: `plate height before ${before.lo}–${before.hi} after ${after.lo}–${after.hi}` });
  });

  test('Dusk and Ink themes via Appearance, with before/after shots', async ({ page }) => {
    await mkdir(SHOT, { recursive: true });
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await waitReady(page);

    for (const theme of [
      { name: 'Dusk' as const, tag: 'dark', accent: null as string | null },
      { name: 'Ink' as const, tag: 'ink', accent: '#ff6a2e' },
    ]) {
      await chooseAppearance(page, theme.name);
      expect(await viewportLum(page)).toBeLessThan(80);
      if (theme.accent) {
        const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase());
        expect(accent).toBe(theme.accent);
      }

      await openTab(page, 'Image / Graphic');
      const plate = page.getByTestId('flat-plate');
      await expect(plate).toBeVisible();
      await plate.getByRole('button', { name: 'Off', exact: true }).click();
      await expect(plate).toHaveAttribute('data-mode', 'off');
      await plate.screenshot({ path: join(SHOT, `controls-before-${theme.tag}.png`) });
      expect(await fieldsetContrast(page)).toBeGreaterThanOrEqual(4.5);

      await openTab(page, '3D');
      await expect.poll(async () => plateRange(page).then((r) => r.lo), { timeout: 30_000 }).toBeTruthy();
      const before = await plateRange(page);
      await page.locator('.view').screenshot({ path: join(SHOT, `3d-before-${theme.tag}.png`) });

      await openTab(page, 'Image / Graphic');
      await plate.getByRole('button', { name: 'Auto', exact: true }).click();
      await expect(plate).toHaveAttribute('data-mode', 'auto');
      await setFlatLevelMetres(page, 5);
      await plate.screenshot({ path: join(SHOT, `controls-after-${theme.tag}.png`) });

      await openTab(page, '3D');
      await expect.poll(async () => plateRange(page).then((r) => r.lo), { timeout: 30_000 }).toBeGreaterThan(before.lo);
      await page.waitForTimeout(600);
      await page.locator('.view').screenshot({ path: join(SHOT, `3d-after-${theme.tag}.png`) });
    }
  });
});
