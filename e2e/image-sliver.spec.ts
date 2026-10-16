import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gabrielProjectJson } from '../test/image-sliver-fixture';
import { dxfEntitySummary, listDxfEntities } from '../src/core/dxf';

const SHOT = join(process.cwd(), 'docs/screenshots/image-sliver');

async function seed(page: Page, fragmentMode: 'auto' | 'keep' = 'auto') {
  await page.addInitScript(
    ({ project }) => {
      localStorage.setItem('strata:tour-seen', '1');
      localStorage.setItem('strata.project.v1', project);
      localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: { Fabrication: false }, ortho: true }));
    },
    { project: gabrielProjectJson(fragmentMode) },
  );
}

async function waitReady(page: Page) {
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await expect(page.getByTestId('status-counts')).toContainText(/\d+\s+plates/, { timeout: 90_000 });
}

test.describe('image sliver and cut-only sheet DXF', () => {
  test('Gabriel settings: auto-drop sliver, counts agree, cut DXF entities', async ({ page }) => {
    await mkdir(SHOT, { recursive: true });
    await seed(page, 'auto');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await waitReady(page);

    const counts = page.getByTestId('status-counts');
    await expect(counts).toContainText('6 plates · 6 parts', { timeout: 90_000 });
    await expect(page.getByTestId('inspector-plates')).toContainText('6');
    await expect(page.getByTestId('inspector-plates')).toContainText('6 parts');
    await expect(page.getByTestId('fragment-notice')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fragment-notice')).toContainText(/Dropped|Merged/i);

    await page.locator('.view').screenshot({ path: join(SHOT, '3d.png') });
    await page.locator('.statusbar').screenshot({ path: join(SHOT, 'status.png') });
    await page.locator('.right.window').screenshot({ path: join(SHOT, 'inspector.png') });
    await page.getByTestId('fragment-notice').screenshot({ path: join(SHOT, 'fragment-notice.png') });

    await page.locator('.ws-tabs').getByRole('tab', { name: 'Plates' }).click();
    await expect(page.getByTestId('plates-list-count')).toContainText('6 plates · 6 parts', { timeout: 30_000 });
    await page.locator('.split, .list').first().screenshot({ path: join(SHOT, 'plates.png') });

    await page.locator('.ws-tabs').getByRole('tab', { name: 'Nest' }).click();
    await expect(page.getByRole('button', { name: 'Cut DXF' }).first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.scroll, .pad').first().screenshot({ path: join(SHOT, 'nest.png') });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Cut DXF' }).first().click();
    const download = await downloadPromise;
    const fail = await download.failure();
    expect(fail).toBeNull();
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      if (!stream) return reject(new Error('no download stream'));
      stream.on('data', (c) => chunks.push(Buffer.from(c)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const dxf = Buffer.concat(chunks).toString('utf8');
    const sum = dxfEntitySummary(dxf);
    const ents = listDxfEntities(dxf);
    const lines = [
      `file: ${download.suggestedFilename()}`,
      `ACADVER: ${/AC10\d{2}/.exec(dxf)?.[0] ?? 'missing'}`,
      `entity types: ${JSON.stringify(sum.types)}`,
      `layers: ${JSON.stringify(sum.layers)}`,
      `CUT entities: ${ents.filter((e) => e.layer === 'CUT').length}`,
      `non-CUT entities: ${ents.filter((e) => e.layer !== 'CUT').length}`,
      `has LWPOLYLINE: ${Boolean(sum.types.LWPOLYLINE)}`,
      `has CIRCLE: ${Boolean(sum.types.CIRCLE)}`,
      `has POLYLINE: ${Boolean(sum.types.POLYLINE)}`,
      `has SPLINE: ${Boolean(sum.types.SPLINE)}`,
      `has LINE: ${Boolean(sum.types.LINE)}`,
      `has ETCH layer: ${Boolean(sum.layers.ETCH)}`,
      `has SHEET layer: ${Boolean(sum.layers.SHEET)}`,
    ];
    await writeFile(join(SHOT, 'sheet-dxf-entities.txt'), lines.join('\n') + '\n', 'utf8');
    expect(download.suggestedFilename()).toMatch(/sheet-0?1-cut\.dxf/);
    expect(sum.types.LWPOLYLINE).toBeGreaterThan(0);
    expect(sum.types.SPLINE).toBeUndefined();
    expect(sum.types.POLYLINE).toBeUndefined();
    expect(sum.layers.ETCH).toBeUndefined();
    expect(sum.layers.SHEET).toBeUndefined();
    expect(ents.every((e) => e.layer === 'CUT')).toBe(true);
  });
});
