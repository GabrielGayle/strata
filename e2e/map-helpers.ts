import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const MAP_READY_MS = process.env.LIVE_MAP === '1' || process.env.LIVE_MAP_SCREENSHOTS === '1' ? 300_000 : 90_000;

/** First-visit Help tour (1.5 s) covers the chrome and steals toolbar clicks. */
export async function dismissTour(page: Page) {
  const dlg = page.getByRole('dialog', { name: /Tour:/ });
  const visible = await dlg
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) return;
  await dlg.getByRole('button', { name: 'Skip' }).click();
  await dlg.waitFor({ state: 'hidden', timeout: 5_000 });
}

/** Fresh Playwright contexts have no tour-seen flag; the 1.5 s Composer tour steals clicks. */
export async function openApp(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('strata:tour-seen', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await dismissTour(page);
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

export async function waitForMapReady(page: Page) {
  const root = page.locator('.app.window');
  await expect
    .poll(
      async () => {
        const phase = (await root.getAttribute('data-strata-map-phase')) ?? '';
        if (phase === 'error') {
          const err = (await root.getAttribute('data-strata-map-error'))?.trim();
          throw new Error(err || 'map terrain error');
        }
        const range = Number(await root.getAttribute('data-strata-plate-height-range-mm'));
        const expected = Number(await root.getAttribute('data-strata-map-expected-height-mm'));
        return phase === 'ready' && range > 0 && expected > 0 ? range : 0;
      },
      { timeout: MAP_READY_MS, intervals: [150, 300, 600, 1000] },
    )
    .toBeGreaterThan(0);
}

/** Toolbar Maps ▾ → Neasden (preset auto-builds; there is no Build button). */
export async function pickNeasdenPreset(page: Page) {
  await dismissTour(page);
  await page.getByRole('button', { name: 'Maps ▾' }).click();
  await page.locator('.menu-pop').getByRole('button', { name: /^Neasden\b/ }).first().click();
  await waitForMapReady(page);
}

/** Map tab preset row — also auto-builds. */
export async function clickMapPreset(page: Page, label: string) {
  await dismissTour(page);
  await openWorkspaceTab(page, 'Map');
  await page.locator('.map-preset-row').getByRole('button', { name: label, exact: true }).click();
}

export async function applyNeasdenDesign(page: Page) {
  await dismissTour(page);
  // Blur the parameter filter (it steals `/` if focused) then open the design box.
  await page.locator('.app.window').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input', { timeout: 15_000 });
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();
  await waitForMapReady(page);
  await dismissTour(page);
}

export async function plateHeightRangeMm(page: Page): Promise<number> {
  const raw = await page.locator('.app.window').getAttribute('data-strata-plate-height-range-mm');
  return Number(raw);
}

export async function assertPlateHeightMatchesRelief(page: Page, tolerance = 0.3) {
  await expect
    .poll(async () => Number(await page.locator('.app.window').getAttribute('data-strata-plate-height-range-mm')), {
      timeout: 60_000,
    })
    .toBeGreaterThan(40);

  const metrics = await page.evaluate(() => {
    const el = document.querySelector('.app.window') as HTMLElement | null;
    if (!el) return null;
    return {
      reliefM: Number(el.dataset.strataMapReliefM),
      exaggeration: Number(el.dataset.strataMapExaggeration),
      scale: Number(el.dataset.strataMapScaleMmPerM),
      expected: Number(el.dataset.strataMapExpectedHeightMm),
      actual: Number(el.dataset.strataPlateHeightRangeMm),
    };
  });
  expect(metrics).toBeTruthy();
  const { reliefM, exaggeration, scale, expected, actual } = metrics!;
  expect(reliefM).toBeGreaterThan(0);
  expect(exaggeration).toBeGreaterThan(0);
  expect(scale).toBeGreaterThan(0);
  expect(expected).toBeCloseTo(reliefM * exaggeration * scale, 4);
  expect(actual).toBeGreaterThan(expected * (1 - tolerance));
  expect(actual).toBeLessThan(expected * (1 + tolerance));
}

export async function assertMapPreviewNonUniform(page: Page) {
  await page.locator('.map-preview-canvas').waitFor({ state: 'visible', timeout: 30_000 });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('.map-preview-canvas') as HTMLCanvasElement | null;
          if (!canvas || canvas.width < 16) return 0;
          const ctx = canvas.getContext('2d');
          if (!ctx) return 0;
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const keys = new Set<number>();
          for (let i = 0; i < img.length; i += 4) {
            if (img[i + 3] === 0) continue;
            keys.add(img[i] * 65536 + img[i + 1] * 256 + img[i + 2]);
          }
          return keys.size;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(8);
}

export async function openWorkspaceTab(page: Page, label: string) {
  await page.locator('.ws-tabs [role="tab"]', { hasText: label }).click();
}

export async function waitForViewportRelief(page: Page) {
  await openWorkspaceTab(page, '3D');
  await expect
    .poll(async () => Number(await page.locator('.app.window').getAttribute('data-strata-plate-height-range-mm')), {
      timeout: MAP_READY_MS,
    })
    .toBeGreaterThan(40);
  const canvas = page.locator('.main canvas').first();
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const buf = await canvas.screenshot({ type: 'png' });
        const png = PNG.sync.read(Buffer.from(buf));
        const keys = new Set<number>();
        for (let i = 0; i < png.data.length; i += 16) {
          if (png.data[i + 3] < 8) continue;
          keys.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
          if (keys.size >= 8) return keys.size;
        }
        return keys.size;
      },
      { timeout: 30_000, intervals: [200, 400, 800] },
    )
    .toBeGreaterThanOrEqual(3);
}

export async function waitForThemeMode(page: Page, mode: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode, { timeout: 10_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function waitForPlatesView(page: Page) {
  await openWorkspaceTab(page, 'Plates');
  await expect(page.locator('.tbl.interactive')).toBeVisible({ timeout: 20_000 });
}

export async function setThemePreset(page: Page, name: string) {
  await page.getByRole('button', { name: 'Appearance ▾' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Escape');
}
