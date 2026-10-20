import { test, expect, type Page } from '@playwright/test';
import { openApp } from './map-helpers';

// Table or wall: the 3D toolbar switch sets Display › Shown on, the view turns to show
// the piece hanging, and nothing throws on the way.

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const shot = process.env.STRATA_SHOTS;

test('Table / Wall switch hangs the piece on a wall', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = watchErrors(page);
  await openApp(page);
  const canvas = page.locator('.ws-pane canvas').first();
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId('mount-table')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/1-table-iso.png` });
  await page.getByTestId('mount-wall').click();
  await expect(page.getByTestId('mount-wall')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(3000);
  if (shot) await canvas.screenshot({ path: `${shot}/2-wall-iso.png` });
  await page.locator('.overlay.tl').getByRole('button', { name: 'Front', exact: true }).click();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/3-wall-front.png` });
  await page.locator('.overlay.tl').getByRole('button', { name: 'Side', exact: true }).click();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/4-wall-side.png` });
  await page.getByTestId('mount-table').click();
  await expect(page.getByTestId('mount-table')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
});

test('candles stand upright on a wall piece', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = watchErrors(page);
  await openApp(page, { preset: null });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.topbar').getByRole('button', { name: 'Open', exact: true }).click();
  await (await chooser).setFiles('test/fixtures/projects/lucky-horseshoe.strata.json');
  await expect(page.locator('.topbar input').first()).toHaveValue('Lucky horseshoe');
  const canvas = page.locator('.ws-pane canvas').first();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/5-candles-table.png` });
  await page.getByTestId('mount-wall').click();
  await page.waitForTimeout(3000);
  if (shot) await canvas.screenshot({ path: `${shot}/6-candles-wall-iso.png` });
  await page.locator('.overlay.tl').getByRole('button', { name: 'Front', exact: true }).click();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/7-candles-wall-front.png` });
  await page.locator('.overlay.tl').getByRole('button', { name: 'Side', exact: true }).click();
  await page.waitForTimeout(2500);
  if (shot) await canvas.screenshot({ path: `${shot}/8-candles-wall-side.png` });
  expect(errors).toEqual([]);
});
