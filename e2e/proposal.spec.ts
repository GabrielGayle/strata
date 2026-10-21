import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openApp, pickNeasdenPreset } from './map-helpers';

const shots = join(process.cwd(), 'docs/screenshots/proposal');

test('proposal from a map relief: placeholders, est. price, ortho views, folded spec; no link', async ({ page, context }) => {
  test.setTimeout(180_000);
  await mkdir(shots, { recursive: true });
  await openApp(page);
  await pickNeasdenPreset(page);
  await page.locator('[data-hl="proposal"]').click();
  const dialog = page.getByRole('dialog', { name: 'Client proposal' });
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-proposal="client"]').fill('Example client');
  await dialog.locator('[data-proposal="number"]').fill('001');
  await dialog.locator('[data-proposal="price"]').fill('£4,800');
  // a map needs its terrain, which a link can't carry
  await expect(dialog.locator('[data-hl="proposal-link"]')).toBeDisabled();
  await dialog.screenshot({ path: join(shots, 'dialog.png') });

  const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('[data-hl="proposal-download"]').click()]);
  const html = await readFile((await download.path())!, 'utf8');
  const doc = await context.newPage();
  await doc.setViewportSize({ width: 960, height: 900 });
  await doc.setContent(html, { waitUntil: 'load' });
  await expect(doc.locator('h1')).toHaveText('Neasden');
  await expect(doc.locator('.terms')).toContainText('£4,800 est.');
  await expect(doc.locator('.terms')).toContainText('[finish to confirm]');
  await expect(doc.locator('.ortho > svg > svg')).toHaveCount(3);
  await expect(doc.locator('details.spec')).not.toHaveAttribute('open', /.*/);
  await doc.screenshot({ path: join(shots, 'page.png'), fullPage: true });
  await doc.locator('details.spec summary').click();
  await doc.locator('details.spec').screenshot({ path: join(shots, 'technical-sheet.png') });
});

test('a proposal link opens the page at /p, built from the design', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
  await page.locator('[data-hl="proposal"]').click();
  const dialog = page.getByRole('dialog', { name: 'Client proposal' });
  await dialog.locator('[data-proposal="place"]').fill('Vermilion');
  await dialog.locator('[data-proposal="timeline"]').fill('About six weeks from approval');
  await dialog.locator('[data-hl="proposal-link"]').click();
  const url = await dialog.getByLabel('Proposal link').inputValue();
  expect(url).toMatch(/\/p#s=/);
  const doc = await context.newPage();
  await doc.setViewportSize({ width: 960, height: 900 });
  await doc.goto(url);
  await expect(doc.locator('h1')).toHaveText('Vermilion', { timeout: 60_000 });
  await expect(doc.locator('.terms')).toContainText('About six weeks from approval');
  await doc.evaluate(() => document.fonts.ready);
  await expect(doc.locator('.ortho > svg > svg')).toHaveCount(3);
  await doc.screenshot({ path: join(shots, 'link-page.png'), fullPage: true });
});
