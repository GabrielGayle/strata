import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  assertZeroFitErrors,
  clickQuickMap,
  openApp,
  openWorkspaceTab,
  waitForMapReady,
  waitForViewportRelief,
} from './map-helpers';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live Buttermere water flattening');

const shotDir = join(process.cwd(), 'docs/screenshots/buttermere');
const isBefore = process.env.BUTTERMERE_WATER_SHOT === 'before';
const shotName = isBefore ? 'water-before.png' : 'water-after.png';

async function setBaseSizeMm(page: Page, length: number, width: number) {
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

async function applyMapBbox(page: Page, bbox: [number, number, number, number], title: string) {
  await openWorkspaceTab(page, 'Map');
  await page.locator('#map-title').fill(title);
  const grid = page.locator('.map-bbox-grid');
  await grid.getByLabel('West').fill(String(bbox[0]));
  await grid.getByLabel('South').fill(String(bbox[1]));
  await grid.getByLabel('East').fill(String(bbox[2]));
  await grid.getByLabel('North').fill(String(bbox[3]));
  await page.getByRole('button', { name: 'Apply bbox & title' }).click();
}

async function snapViewportDir(page: Page, dir: 'iso' | 'top', ortho = true) {
  await openWorkspaceTab(page, '3D');
  const view = page.getByTestId('viewport-3d');
  await view.getByRole('button', { name: dir === 'iso' ? 'Iso' : 'Top' }).click();
  const orthoBtn = view.getByRole('button', { name: 'Ortho' });
  const on = await orthoBtn.getAttribute('class');
  if (ortho && !on?.includes('on')) await orthoBtn.click();
  if (!ortho && on?.includes('on')) await orthoBtn.click();
}

function scalePngToHeight(src: Buffer, height: number): Buffer {
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

function downscalePng(src: Buffer, maxWidth = 720): Buffer {
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

function stitchPngSideBySide(leftBuf: Buffer, rightBuf: Buffer, gap = 8): Buffer {
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

function compressPngFile(dest: string) {
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

test('live Buttermere 500×500: lakes sit in the valleys, not a highland plateau', async ({ page }) => {
  test.setTimeout(420_000);
  await mkdir(shotDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await setBaseSizeMm(page, 500, 500);
  await applyMapBbox(page, BUTTERMERE_BBOX, 'Buttermere');
  await clickQuickMap(page);
  await waitForMapReady(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByLabel('Vertical exaggeration').selectOption('4');
  await waitForMapReady(page);
  if (!isBefore) await assertZeroFitErrors(page);

  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-phase', 'ready');
  await expect(page.locator('.overlay.bl.info')).toContainText(/500\s*×\s*500/);
  await expect(page.locator('#map-water-bathy')).toBeChecked();
  if (!isBefore) await expect(page.getByText(/Each lake uses its own shoreline/)).toBeVisible();

  await snapViewportDir(page, 'top', true);
  await waitForViewportRelief(page);
  const top3d = page.getByTestId('viewport-3d');
  await expect(top3d.getByRole('button', { name: 'Top' })).toHaveClass(/on/);
  await expect(page.getByTestId('plate-height-range')).toContainText(/terrain/i);
  const threeBuf = Buffer.from(await top3d.screenshot({ type: 'png' }));

  await openWorkspaceTab(page, 'Map');
  const preview = page.locator('.map-preview-pane');
  await expect(preview).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('.map-preview-canvas') as HTMLCanvasElement | null;
          return canvas?.width ?? 0;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(16);
  const mapBuf = Buffer.from(await preview.screenshot({ type: 'png' }));
  const threePng = PNG.sync.read(threeBuf);
  const dest = join(shotDir, shotName);
  await writeFile(dest, downscalePng(stitchPngSideBySide(threeBuf, scalePngToHeight(mapBuf, threePng.height)), 720));
  compressPngFile(dest);
});
