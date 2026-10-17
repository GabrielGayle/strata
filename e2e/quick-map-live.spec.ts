import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
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

function downscalePng(src: Buffer, maxWidth = 560): Buffer {
  const png = PNG.sync.read(src);
  const scale = Math.min(1, maxWidth / png.width);
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  if (w === png.width && h === png.height) return PNG.sync.write(png, { deflateLevel: 9 });
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
  const canvas = page.locator('.main canvas').first();
  await expect(canvas).toBeVisible();
  const buf = await canvas.screenshot({ type: 'png' });
  await writeFile(join(shotDir, name), downscalePng(Buffer.from(buf)));
}

test('live Quick map: Neasden, Kingsbarns, Royal County Down', async ({ page }) => {
  test.setTimeout(900_000);
  await mkdir(shotDir, { recursive: true });
  await openApp(page);

  const log: Record<string, { before: Awaited<ReturnType<typeof readFit>>; after: Awaited<ReturnType<typeof readFit>> }> = {};

  for (const place of PLACES) {
    await pickMapPreset(page, place.label);
    await snap3d(page, `${place.id}-before.png`);
    const before = await readFit(page);

    await clickQuickMap(page);
    await waitForMapReady(page);
    await openWorkspaceTab(page, 'Map');
    await expect(page.getByLabel('Preset & font pairing')).toHaveValue('survey');
    await expect(page.getByTestId('map-engrave-labels')).toBeChecked();
    await expect(page.locator('#map-water-bathy')).toBeChecked();
    await expect(page.getByLabel('Vertical exaggeration')).toHaveValue('auto');

    await assertZeroFitErrors(page);
    await assertNoThin2mmWarnings(page);
    const after = await readFit(page);
    log[place.id] = { before, after };
    // eslint-disable-next-line no-console
    console.log(`quick-map live ${place.id}`, { before, after });

    await snap3d(page, `${place.id}-after.png`);
    expect(after.errors, `${place.label} ${after.errorsText}`).toBe(0);
    expect(after.thin, `${place.label} still has 2 mm thin warnings`).toBe(0);
  }

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await waitForMapReady(page);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByLabel('Preset & font pairing')).not.toHaveValue('survey');
});
