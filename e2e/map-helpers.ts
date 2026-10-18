import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { PNG } from 'pngjs';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';

const MAP_READY_MS = process.env.LIVE_MAP === '1' || process.env.LIVE_MAP_SCREENSHOTS === '1' ? 300_000 : 90_000;

/** Record browser alerts so RangeTest popups fail the test instead of hanging. */
export function attachDialogGuard(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

export async function waitForMapTerrainError(page: Page, text?: RegExp) {
  const err = page.getByTestId('map-terrain-error');
  await expect(err).toBeVisible({ timeout: MAP_READY_MS });
  await expect(err).toContainText(
    text ??
      /Couldn't build plates.*gap or bad value|Couldn't reach the elevation service|height for this landscape is out of range/i,
  );
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-phase', 'error');
}

/** After Quick map / Apply, Queued must not linger — the build either runs or the error returns. */
export async function waitUntilMapNotStuckQueued(page: Page, timeout = 8_000) {
  const root = page.locator('.app.window');
  await expect
    .poll(
      async () => {
        const phase = (await root.getAttribute('data-strata-map-phase')) ?? '';
        const status = (await page.locator('.map-terrain-status').textContent()) ?? '';
        return phase === 'working' && /Queued terrain build/i.test(status) ? 'queued' : phase;
      },
      { timeout, intervals: [100, 200, 400] },
    )
    .not.toBe('queued');
}

/** Replace the offline EA DTM with bilinear-blended nodata (~−1.7e38). */
export async function injectNodataBlendedDem(page: Page) {
  await page.route('**/map-fixtures/regional/neasden-ea-dtm.json', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { data: number[] };
    json.data = json.data.map(() => -1.7e38);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
}

/** Must stay self-contained: Playwright serializes this into the browser. */
export function seedAllTourSeenKeys() {
  try {
    const keys = new Set<string>(['strata:tour-seen']);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /tour-seen/i.test(k)) keys.add(k);
    }
    for (const k of keys) localStorage.setItem(k, '1');
  } catch {
    /* private window or blocked storage */
  }
}

/**
 * Skip every first-visit Tour: dialog. A second Composer tour can auto-start
 * ~1.5 s after the first Skip (HelpLayer timeout does not re-check tour-seen).
 * Pass a longer waitMs at startup; later calls only clear a leftover overlay.
 */
export async function dismissTour(page: Page, opts?: { waitMs?: number }) {
  const waitMs = opts?.waitMs ?? 250;
  const dlg = page.getByRole('dialog', { name: /Tour:/ });
  for (let n = 0; n < 8; n++) {
    const visible = await dlg
      .waitFor({ state: 'visible', timeout: n === 0 ? waitMs : Math.max(waitMs, 1_800) })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      await dlg.getByRole('button', { name: 'Skip' }).click();
      await dlg.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      continue;
    }
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      continue;
    }
    return;
  }
}

/** Fresh Playwright contexts have no tour-seen flag; the 1.5 s Composer tour steals clicks. */
export async function openApp(page: Page) {
  await page.addInitScript(seedAllTourSeenKeys);
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await dismissTour(page, { waitMs: 2_000 });
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
        // the plates come from the engine worker a moment after the project changes
        if ((await root.getAttribute('data-strata-model-current')) !== '1') return 0;
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

export async function clickQuickMap(page: Page) {
  await dismissTour(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByTestId('quick-map').click();
}

/** Toolbar Maps ▾ → named place (preset auto-builds). */
export async function pickMapPreset(page: Page, label: string) {
  await dismissTour(page);
  await page.getByRole('button', { name: 'Maps ▾' }).click();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.locator('.menu-pop').getByRole('button', { name: new RegExp(`^${escaped}\\b`) }).first().click();
  await waitForMapReady(page);
}

export async function assertNoThin2mmWarnings(page: Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  await expect(page.locator('.issue').filter({ hasText: /narrower than 2 mm/ })).toHaveCount(0);
}

export async function assertZeroFitErrors(page: Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  await expect(page.locator('.status-bar-field').filter({ hasText: /errors/ })).toHaveText('0 errors');
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

/** Once the model on screen has caught up with the project, so intermediate engine results aren't read. */
export async function waitForModelCurrent(page: Page) {
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-model-current', '1', { timeout: 60_000 });
}

export async function plateHeightRangeMm(page: Page): Promise<number> {
  await waitForModelCurrent(page);
  const raw = await page.locator('.app.window').getAttribute('data-strata-plate-height-range-mm');
  return Number(raw);
}

export async function assertPlateHeightMatchesRelief(page: Page, tolerance = 0.3) {
  await waitForModelCurrent(page);
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

export async function applyDesignText(page: Page, text: string) {
  await dismissTour(page);
  await page.locator('.app.window').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input', { timeout: 15_000 });
  await page.fill('.design-box .design-input', text);
  await page.locator('.design-box').getByRole('button', { name: 'Apply' }).click();
}

export async function setBaseSizeMm(page: Page, length: number, width: number) {
  const base = page.locator('[data-group="Base"]');
  const head = base.locator('button.section-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  const len = base.getByLabel('Length value');
  await len.fill(String(length));
  await len.blur();
  const wid = base.getByLabel('Width value');
  await wid.fill(String(width));
  await wid.blur();
  await expect(page.locator('.overlay.bl.info').first()).toContainText(new RegExp(`${length}\\s*×\\s*${width}`), {
    timeout: 20_000,
  });
}

/** Map tab bbox fields + Apply. Auto-builds once the spec is set. */
export async function applyMapBbox(
  page: Page,
  bbox: [number, number, number, number] = BUTTERMERE_BBOX,
  title = 'Buttermere',
) {
  await dismissTour(page);
  await openWorkspaceTab(page, 'Map');
  await page.locator('#map-title').fill(title);
  const grid = page.locator('.map-bbox-grid');
  await grid.getByLabel('West').fill(String(bbox[0]));
  await grid.getByLabel('South').fill(String(bbox[1]));
  await grid.getByLabel('East').fill(String(bbox[2]));
  await grid.getByLabel('North').fill(String(bbox[3]));
  await page.getByRole('button', { name: 'Apply bbox & title' }).click();
}

export async function snapViewportDir(page: Page, dir: 'iso' | 'front' | 'side' | 'top', ortho = true) {
  await openWorkspaceTab(page, '3D');
  const view = page.getByTestId('viewport-3d');
  await view.getByRole('button', { name: dir === 'iso' ? 'Iso' : dir === 'front' ? 'Front' : dir === 'side' ? 'Side' : 'Top' }).click();
  const orthoBtn = view.getByRole('button', { name: 'Ortho' });
  const on = await orthoBtn.getAttribute('class');
  if (ortho && !on?.includes('on')) await orthoBtn.click();
  if (!ortho && on?.includes('on')) await orthoBtn.click();
}

export function scalePngToHeight(src: Buffer, height: number): Buffer {
  const png = PNG.sync.read(src);
  const scale = height / Math.max(1, png.height);
  const w = Math.max(1, Math.round(png.width * scale));
  const h = height;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(png.height - 1, Math.round(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(png.width - 1, Math.round(x / scale));
      const i = (png.width * sy + sx) << 2;
      const j = (w * y + x) << 2;
      out.data[j] = png.data[i];
      out.data[j + 1] = png.data[i + 1];
      out.data[j + 2] = png.data[i + 2];
      out.data[j + 3] = png.data[i + 3];
    }
  }
  return PNG.sync.write(out, { deflateLevel: 9 });
}

export function downscalePng(src: Buffer, maxWidth = 400): Buffer {
  const png = PNG.sync.read(src);
  const scale = Math.min(1, maxWidth / png.width);
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(png.height - 1, Math.round(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(png.width - 1, Math.round(x / scale));
      const i = (png.width * sy + sx) << 2;
      const j = (w * y + x) << 2;
      out.data[j] = png.data[i];
      out.data[j + 1] = png.data[i + 1];
      out.data[j + 2] = png.data[i + 2];
      out.data[j + 3] = png.data[i + 3];
    }
  }
  return PNG.sync.write(out, { deflateLevel: 9 });
}

export function stitchPngSideBySide(leftBuf: Buffer, rightBuf: Buffer, gap = 8): Buffer {
  const left = PNG.sync.read(leftBuf);
  const right = PNG.sync.read(rightBuf);
  const h = Math.max(left.height, right.height);
  const w = left.width + gap + right.width;
  const out = new PNG({ width: w, height: h });
  out.data.fill(230);
  const blit = (src: PNG, dx: number) => {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (src.width * y + x) << 2;
        const j = (w * y + (dx + x)) << 2;
        out.data[j] = src.data[i];
        out.data[j + 1] = src.data[i + 1];
        out.data[j + 2] = src.data[i + 2];
        out.data[j + 3] = src.data[i + 3];
      }
    }
  };
  blit(left, 0);
  blit(right, left.width + gap);
  return PNG.sync.write(out, { deflateLevel: 9 });
}

export function compressPngFile(dest: string) {
  const tmp = `${dest}.tmp.png`;
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', dest, '-vf', 'format=rgb24', '-compression_level', '100', tmp],
      { stdio: 'pipe' },
    );
    if (existsSync(tmp)) renameSync(tmp, dest);
  } catch {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
