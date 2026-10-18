import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  assertNoThin2mmWarnings,
  assertZeroFitErrors,
  clickQuickMap,
  openApp,
  openWorkspaceTab,
  pickMapPreset,
  waitForMapReady,
  waitForViewportRelief,
} from './map-helpers';

test.skip(!process.env.LIVE_MAP, 'Set LIVE_MAP=1 to run live network Quick map tests');

const PLACES = [
  { id: 'neasden', label: 'Neasden' },
  { id: 'kingsbarns', label: 'Kingsbarns' },
  { id: 'royal-county-down', label: 'Royal County Down' },
] as const;

const shotDir = join(process.cwd(), 'docs/screenshots/quick-map');

function downscalePng(src: Buffer, maxWidth = 400): Buffer {
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

async function readFit(page: import('@playwright/test').Page) {
  await expect(page.locator('.statusbar')).not.toContainText(/updating checks/i);
  const errorsText = await page.locator('.status-bar-field').filter({ hasText: /errors/ }).textContent();
  const warningsText = await page.locator('.status-bar-field').filter({ hasText: /warnings/ }).textContent();
  const thin = await page.locator('.issue').filter({ hasText: /narrower than 2 mm/ }).count();
  return {
    errors: Number(errorsText?.match(/(\d+)\s+errors/)?.[1] ?? -1),
    warnings: Number(warningsText?.match(/(\d+)\s+warnings/)?.[1] ?? -1),
    thin,
    errorsText: errorsText?.trim() ?? '',
    warningsText: warningsText?.trim() ?? '',
  };
}

async function snap3d(page: import('@playwright/test').Page, name: string) {
  await openWorkspaceTab(page, '3D');
  await waitForViewportRelief(page);
  const view = page.getByTestId('viewport-3d');
  await expect(view).toBeVisible();
  const buf = await view.screenshot({ type: 'png' });
  const dest = join(shotDir, name);
  await writeFile(dest, downscalePng(Buffer.from(buf)));
  compressPngFile(dest);
}

async function partsText(page: import('@playwright/test').Page) {
  return (await page.locator('.status-bar-field').filter({ hasText: /parts/ }).first().textContent())?.trim() ?? '';
}

test('live Quick map: Neasden, Kingsbarns, Royal County Down', async ({ browser }) => {
  test.setTimeout(900_000);
  await mkdir(shotDir, { recursive: true });

  for (const place of PLACES) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await pickMapPreset(page, place.label);

    const before = await readFit(page);
    const beforeParts = await partsText(page);
    await snap3d(page, `${place.id}-before.png`);

    await clickQuickMap(page);
    await waitForMapReady(page);
    await openWorkspaceTab(page, 'Map');
    await expect(page.getByLabel('Preset & font pairing')).toHaveValue('survey');
    await expect(page.getByTestId('map-engrave-labels')).toBeChecked();
    await expect(page.locator('#map-water-flat')).toBeChecked();
    await expect(page.getByLabel('OSM engrave on top face')).toBeChecked();
    await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('auto');

    await assertZeroFitErrors(page);
    await assertNoThin2mmWarnings(page);
    const after = await readFit(page);
    // eslint-disable-next-line no-console
    console.log(`quick-map live ${place.id}`, { before, after, beforeParts, afterParts: await partsText(page) });

    await snap3d(page, `${place.id}-after.png`);
    expect(after.errors, `${place.label} ${after.errorsText}`).toBe(0);
    expect(after.thin, `${place.label} still has 2 mm thin warnings`).toBe(0);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitForMapReady(page);
    expect(await partsText(page)).toBe(beforeParts);

    await context.close();
  }
});
