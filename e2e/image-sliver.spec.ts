import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gabrielProjectJson } from '../test/image-sliver-fixture';
import { readFileSync } from 'node:fs';
import { dxfCutStructure, dxfEntitySummary, listDxfEntities } from '../src/core/dxf';

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
      `has sheet border: ${dxfCutStructure(dxf).hasBorder}`,
    ];
    const commissaryDir = join(process.cwd(), 'test/fixtures/commissary');
    lines.push('', 'Commissary cut-only refs:');
    for (const name of ['coarse-cut-only.dxf', 'medium-cut-only.dxf', 'fine-cut-only.dxf']) {
      const st = dxfCutStructure(readFileSync(join(commissaryDir, name), 'utf8'));
      lines.push(`  ${name}: types=${JSON.stringify(st.types)} layers=${st.layers.join(',')} border=${st.hasBorder} etch=${st.hasEtch} forbidden=${st.hasForbidden}`);
    }
    const extra = Object.keys(sum.types).filter((t) => t !== 'LWPOLYLINE');
    lines.push(`ours extra vs Commissary: ${extra.length ? extra.join(', ') : '(none)'} (CIRCLE = round holes)`);
    lines.push('both: CUT-only, no sheet border, no ETCH/SHEET/LINE/POLYLINE/SPLINE');
    await writeFile(join(SHOT, 'sheet-dxf-entities.txt'), lines.join('\n') + '\n', 'utf8');
    expect(download.suggestedFilename()).toMatch(/sheet-0?1-cut\.dxf/);
    expect(sum.types.LWPOLYLINE).toBeGreaterThan(0);
    expect(sum.types.SPLINE).toBeUndefined();
    expect(sum.types.POLYLINE).toBeUndefined();
    expect(sum.layers.ETCH).toBeUndefined();
    expect(sum.layers.SHEET).toBeUndefined();
    expect(ents.every((e) => e.layer === 'CUT')).toBe(true);
  });

  test('Export ZIP refuses while keep-mode still has fit errors', async ({ page }) => {
    await seed(page, 'keep');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await waitReady(page);
    await expect(page.locator('.status-bar-field').filter({ hasText: /errors/ })).not.toHaveText('0 errors', { timeout: 90_000 });
    const downloads: import('@playwright/test').Download[] = [];
    page.on('download', (d) => downloads.push(d));
    await page.getByRole('button', { name: 'Export ZIP' }).click();
    await expect(page.locator('.toast')).toContainText(/Export refused: \d+ fit error(?:s)? remains?/i, { timeout: 15_000 });
    expect(downloads).toHaveLength(0);
  });
});
