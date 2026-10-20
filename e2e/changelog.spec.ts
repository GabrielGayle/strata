import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPreset } from './map-helpers';

const shotDir = join(process.cwd(), 'docs/screenshots/changelog');

async function openChangelog(page: Page) {
  await page.locator('[data-hl="menu-help"]').click();
  await page.locator('[data-hl="help-changelog"]').click();
  const win = page.getByTestId('changelog');
  await expect(win).toBeVisible();
  return win;
}

/** The spotlight's hole sits round the control it found. */
async function expectLit(page: Page, control: string) {
  const spot = page.getByTestId('changelog-spotlight');
  await expect(spot).toHaveAttribute('data-state', 'found', { timeout: 10_000 });
  const hole = spot.locator('.spot-hole');
  await expect(hole).toBeVisible();
  const target = page.locator(control).first();
  await expect
    .poll(async () => {
      const [h, t] = await Promise.all([hole.boundingBox(), target.boundingBox()]);
      return !!h && !!t && Math.abs(h.x + h.width / 2 - (t.x + t.width / 2)) < 3 && Math.abs(h.y + h.height / 2 - (t.y + t.height / 2)) < 3;
    })
    .toBe(true);
}

test('no tour pops up on load', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await expect(page.getByRole('dialog', { name: /Tour:/ })).toHaveCount(0);
  await expect(page.locator('.tour')).toHaveCount(0);
});

test('Help › Changelog lists changes and Show me lights up where each lives', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await loadPreset(page, 'Vermilion 40');
  await mkdir(shotDir, { recursive: true });

  const win = await openChangelog(page);
  await expect(win.locator('.cl-entry').first()).toContainText('Changelog');
  await win.screenshot({ path: join(shotDir, 'window.png') });

  // a 3D view toolbar button
  await win.getByRole('button', { name: /Rake light/ }).click();
  await expect(win).toBeHidden();
  await expectLit(page, '[data-testid="view-aid-rake"]');
  await page.screenshot({ path: join(shotDir, 'rake-light.png') });
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByTestId('changelog-spotlight')).toHaveCount(0);

  // inside a toolbar menu: the menu opens first
  await (await openChangelog(page)).getByRole('button', { name: /Boost \(cloud jobs\)/ }).click();
  await expectLit(page, '[data-testid="boost-toggle"]');
  await page.screenshot({ path: join(shotDir, 'boost-in-settings.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('changelog-spotlight')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // a parameter: its panel opens and the row is lit
  await (await openChangelog(page)).getByRole('button', { name: /Clearer small-part warning/ }).click();
  await expectLit(page, '[data-param="minPartSize"]');
  await page.screenshot({ path: join(shotDir, 'param-row.png') });
  await page.getByRole('button', { name: 'Got it' }).click();

  // a switched-off panel: the panel itself is lit
  await (await openChangelog(page)).getByRole('button', { name: /Steel base: fixing holes/ }).click();
  await expectLit(page, '.section[data-group="Steel base"]');
  await page.getByRole('button', { name: 'Got it' }).click();

  // the 3D view's sidebar: its Candles tab opens and the Candelabra panel is lit
  await (await openChangelog(page)).getByRole('button', { name: /^New Candelabra Candlesticks/ }).click();
  await expectLit(page, '[data-hl="fold-candles:main"]');
  await expect(page.getByTestId('viewport-sidebar')).toHaveClass(/open/);
  await page.screenshot({ path: join(shotDir, 'candelabra.png') });
  await page.getByRole('button', { name: 'Got it' }).click();

  // the card says where in words when the control isn't on screen (no depth photo loaded)
  await (await openChangelog(page)).getByRole('button', { name: /Bas-relief, outline/ }).click();
  await expect(page.getByTestId('changelog-spotlight')).toHaveAttribute('data-state', 'missing', { timeout: 10_000 });
  await expect(page.locator('.spot-card')).toContainText('Image / Graphic');
  await page.screenshot({ path: join(shotDir, 'not-on-screen.png') });
});
