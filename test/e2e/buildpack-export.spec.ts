import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shotDir = join(root, 'docs/screenshots/pack-p0');
const cliffProject = readFileSync(join(root, 'examples/image-cliff.strata.json'), 'utf8');
const neasdenProject = readFileSync(join(root, 'test/fixtures/projects/neasden-buildpack.strata.json'), 'utf8');
const spacersProject = readFileSync(join(root, 'test/fixtures/projects/rods-spacers.strata.json'), 'utf8');

async function injectProject(page: import('@playwright/test').Page, projectJson: string) {
  await page.addInitScript((json) => {
    localStorage.setItem('strata.project.v1', json);
    localStorage.setItem('strata:tour-seen', '1');
  }, projectJson);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('strata:tour-seen', '1');
  });
});

function unzipListing(buf: Buffer, inAppPlates: number): {
  names: string[];
  manifestPlateCount: number;
  listing: string;
  plateDxf: number;
  html: string;
} {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).sort();
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  const plateDxf = names.filter((n) => n.startsWith('plates/') && n.endsWith('.dxf')).length;
  const html = new TextDecoder().decode(files['build-pack.html']);
  const listing = [
    `inAppPlateCount=${inAppPlates}`,
    `manifestPlateCount=${manifest.plateCount}`,
    `plateDxfCount=${plateDxf}`,
    `zipFileCount=${names.length}`,
    '',
    ...names,
  ].join('\n');
  return { names, manifestPlateCount: manifest.plateCount, listing, plateDxf, html };
}

async function inspectorPlateCount(page: import('@playwright/test').Page): Promise<number> {
  const attr = await page.locator('[data-in-app-plates]').getAttribute('data-in-app-plates');
  if (attr && /^\d+$/.test(attr)) return Number(attr);
  const text = await page.locator('.stats .stat').filter({ hasText: 'Plates' }).locator('.v').innerText();
  return Number(text.trim().match(/^\d+/)?.[0] ?? 0);
}

async function dismissTour(page: import('@playwright/test').Page) {
  const tour = page.getByRole('dialog', { name: /Tour:/ });
  if (await tour.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(tour).toHaveCount(0);
  }
}

async function waitForModel(page: import('@playwright/test').Page) {
  await page.waitForSelector('.app.window');
  await dismissTour(page);
  await expect(page.locator('.status-bar-field').filter({ hasText: /plates/ })).toContainText(/\d+\s+plates/, { timeout: 90_000 });
  await expect(page.locator('[data-in-app-plates]')).toHaveAttribute('data-in-app-plates', /[1-9]\d*/, { timeout: 90_000 });
  await dismissTour(page);
}

async function openPlatesTab(page: import('@playwright/test').Page) {
  await dismissTour(page);
  await page.getByRole('tab', { name: /^Plates/ }).first().click();
  await expect(page.locator('.tbl.interactive tbody tr, .cards .card').first()).toBeVisible({ timeout: 60_000 });
}

async function screenshotPackListing(page: import('@playwright/test').Page, listing: string, filename: string) {
  mkdirSync(shotDir, { recursive: true });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Pack contents</title>
<style>body{font:14px/1.4 ui-monospace,monospace;background:#111;color:#f4f1ea;padding:16px} h1{font:700 18px sans-serif} pre{white-space:pre-wrap}</style></head>
<body><h1>Fabrication zip contents</h1><pre>${listing.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</pre></body></html>`);
  await page.screenshot({ path: join(shotDir, filename), fullPage: true });
}

async function screenshotHtmlPack(page: import('@playwright/test').Page, html: string, prefix: string, expected: number) {
  mkdirSync(shotDir, { recursive: true });
  await page.setContent(html);
  await expect(page.locator('.plate-legend')).toBeVisible();
  await expect(page.locator('.plate-legend')).toHaveAttribute('data-plate-count', String(expected));
  await expect(page.locator('.plate-gallery')).toHaveAttribute('data-plate-count', String(expected));
  expect(await page.locator('.plate-card').count()).toBe(expected);
  await page.locator('.plate-legend').screenshot({ path: join(shotDir, `${prefix}-legend.png`) });
  await page.locator('.cover').screenshot({ path: join(shotDir, `${prefix}-cover.png`) });
  await page.locator('.bar').evaluate((el) => {
    (el as HTMLElement).style.visibility = 'hidden';
  });
  await page.locator('#gallery').screenshot({ path: join(shotDir, `${prefix}-gallery.png`) });
  await page.locator('.bar').evaluate((el) => {
    (el as HTMLElement).style.visibility = '';
  });
  if (await page.locator('#layout').count()) {
    await page.locator('#layout').screenshot({ path: join(shotDir, `${prefix}-layout.png`) });
  }
  await page.locator('#show-spacers').uncheck();
  await expect(page.locator('body')).toHaveClass(/hide-spacers/);
  const spacerTarget = (await page.locator('#layout').count()) ? page.locator('#layout') : page.locator('body');
  await spacerTarget.screenshot({ path: join(shotDir, `${prefix}-spacers-off.png`) });
  await page.locator('#show-spacers').check();
}

test('build a design in the app then pack matches in-app plate count', async ({ page }) => {
  await page.goto('/');
  await waitForModel(page);
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: /Stamped stack/ }).click();
  await expect(page.locator('.status-bar-field').filter({ hasText: /parts/ })).toContainText(/\d+\s+parts/, { timeout: 90_000 });
  await openPlatesTab(page);
  mkdirSync(shotDir, { recursive: true });
  await page.locator('.split, .app.window').first().screenshot({ path: join(shotDir, 'plates-tab-stamped.png') });

  const inApp = await inspectorPlateCount(page);
  expect(inApp).toBeGreaterThan(4);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const buf = readFileSync((await download.path())!);
  const { listing, manifestPlateCount, plateDxf, html } = unzipListing(buf, inApp);
  expect(manifestPlateCount, listing.slice(0, 400)).toBe(inApp);
  expect(plateDxf).toBe(inApp);
  writeFileSync(join(shotDir, 'stamped-stack-zip.txt'), listing + '\n');
  await screenshotPackListing(page, listing, 'pack-contents-stamped.png');
  await screenshotHtmlPack(page, html, 'stamped-html', inApp);
});

test('browser export race: double Export ZIP yields one pack', async ({ page }) => {
  await page.goto('/');
  await waitForModel(page);
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByRole('button', { name: /Stamped stack/ }).click();
  await expect(page.locator('.status-bar-field').filter({ hasText: /parts/ })).toContainText(/\d+\s+parts/, { timeout: 90_000 });
  await openPlatesTab(page);
  const inApp = await inspectorPlateCount(page);

  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('button', { name: 'Export ZIP' }).dblclick();
  await expect.poll(() => downloads.length, { timeout: 300_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(800);
  expect(downloads.length).toBe(1);
  const buf = readFileSync((await downloads[0].path())!);
  const zip = unzipListing(buf, inApp);
  expect(zip.manifestPlateCount).toBe(inApp);
  expect(zip.plateDxf).toBe(inApp);
  const toast = page.locator('.toast.window');
  if (await toast.count()) {
    await toast.screenshot({ path: join(shotDir, 'export-race-toast.png') });
  }
});

test('browser-only paths: toolbar ZIP, inspector ZIP, and Build pack popup', async ({ page }) => {
  await injectProject(page, cliffProject);
  await page.goto('/');
  await waitForModel(page);
  await openPlatesTab(page);
  mkdirSync(shotDir, { recursive: true });
  await page.locator('.app.window').screenshot({ path: join(shotDir, 'plates-tab.png') });

  const inApp = await inspectorPlateCount(page);
  expect(inApp).toBeGreaterThan(0);

  const [toolbarDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const toolbarBuf = readFileSync((await toolbarDl.path())!);
  const toolbar = unzipListing(toolbarBuf, inApp);
  expect(toolbar.manifestPlateCount).toBe(inApp);
  expect(toolbar.plateDxf).toBe(inApp);

  await page.waitForTimeout(700);
  const [inspectorDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Everything (ZIP)' }).click(),
  ]);
  const inspectorBuf = readFileSync((await inspectorDl.path())!);
  const inspector = unzipListing(inspectorBuf, inApp);
  expect(inspector.manifestPlateCount).toBe(toolbar.manifestPlateCount);
  expect(inspector.plateDxf).toBe(toolbar.plateDxf);

  mkdirSync(join(root, 'docs/buildpack-verify'), { recursive: true });
  writeFileSync(join(root, 'docs/buildpack-verify/image-cliff-zip.txt'), toolbar.listing + '\n');
  await screenshotPackListing(page, toolbar.listing, 'pack-contents.png');
  await screenshotHtmlPack(page, toolbar.html, 'cliff-html', inApp);

  await page.goto('/');
  await waitForModel(page);
  await dismissTour(page);
  const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
  await page.locator('header.topbar').getByRole('button', { name: 'Build pack' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.locator('.plate-legend')).toHaveAttribute('data-plate-count', String(inApp));
  await expect(popup.locator('.plate-card')).toHaveCount(inApp);
  await popup.locator('#gallery').screenshot({ path: join(shotDir, 'build-pack-popup-gallery.png') });
  await popup.close();
});

test('html pack spacer toggle hides dashed C/T paths', async ({ page }) => {
  await injectProject(page, spacersProject);
  await page.goto('/');
  await waitForModel(page);
  const inApp = await inspectorPlateCount(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const buf = readFileSync((await download.path())!);
  const { html, manifestPlateCount, plateDxf } = unzipListing(buf, inApp);
  expect(manifestPlateCount).toBe(inApp);
  expect(plateDxf).toBe(inApp);
  expect(html).toContain('class="spacer"');
  await screenshotHtmlPack(page, html, 'spacers-html', inApp);
  expect(html).toContain('id="show-spacers"');
});

test('browser export: Neasden map job', async ({ page }) => {
  await injectProject(page, neasdenProject);
  await page.goto('/');
  await waitForModel(page);
  await openPlatesTab(page);
  const inApp = await inspectorPlateCount(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  const { listing, manifestPlateCount, plateDxf } = unzipListing(buf, inApp);
  expect(manifestPlateCount).toBe(inApp);
  expect(plateDxf).toBe(inApp);
  mkdirSync(join(root, 'docs/buildpack-verify'), { recursive: true });
  writeFileSync(join(root, 'docs/buildpack-verify/neasden-map-zip.txt'), listing + '\n');
});
