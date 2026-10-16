import { expect, type Page } from '@playwright/test';

const MAP_READY_MS = 240_000;

export async function waitForMapReady(page: Page) {
  // Do not match leftover "Map terrain ready" — wait for a new in-progress
  // status, or for ready if a fast fixture build already finished.
  await expect(page.locator('.status-bar')).toContainText(/Fetching|building|Queued|Map terrain ready/i, {
    timeout: 20_000,
  });
  await expect(page.locator('.status-bar')).toContainText(/Map terrain ready/i, { timeout: MAP_READY_MS });
}

/** Toolbar Maps ▾ → Neasden (preset auto-builds; there is no Build button). */
export async function pickNeasdenPreset(page: Page) {
  await page.getByRole('button', { name: /Maps/ }).click();
  await page.getByRole('button', { name: /^Neasden\b/ }).first().click();
  await waitForMapReady(page);
}

export async function applyNeasdenDesign(page: Page) {
  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input');
  await page.fill('.design-box .design-input', 'neasden map');
  await page.getByRole('button', { name: 'Apply' }).click();
  await waitForMapReady(page);
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
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('.main canvas') as HTMLCanvasElement | null;
          if (!canvas || canvas.width < 16) return false;
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (!gl) return false;
          const pixels = new Uint8Array(4 * 64);
          gl.readPixels(
            Math.floor(canvas.width * 0.35),
            Math.floor(canvas.height * 0.35),
            8,
            8,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
          );
          const keys = new Set<number>();
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] === 0) continue;
            keys.add(pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2]);
          }
          return keys.size >= 3;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

export async function setThemePreset(page: Page, name: string) {
  await page.getByRole('button', { name: 'Appearance ▾' }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
