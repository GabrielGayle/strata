import { expect, test, type Page } from '@playwright/test';
import { openApp } from './map-helpers';

/** Wait until the plates on screen come from the project as it is now. */
async function settled(page: Page) {
  await expect.poll(async () => page.locator('.app.window').getAttribute('data-strata-model-current'), { timeout: 60_000 }).toBe('1');
}

/** Click the 3D view at a fraction of its size, trying nearby spots until `done` holds. */
async function clickUntil(page: Page, spots: [number, number][], done: () => Promise<boolean>) {
  const box = (await page.locator('.viewport canvas, canvas').first().boundingBox())!;
  for (const [fx, fy] of spots) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(400);
    if (await done()) return true;
  }
  return false;
}

test('place a shelf by clicking the plates, then stand a candle on it', async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const tab3d = page.getByRole('tab', { name: '3D' }).first();
  if (await tab3d.isVisible()) await tab3d.click();
  await settled(page);

  await page.getByTitle(/Place postcards, boxes and other objects/).click();
  await page.getByTestId('objects-tab-shelves').click();
  await page.getByTestId('shelf-add').click();
  await expect(page.getByTestId('placing-note')).toContainText('shelf');

  const spots: [number, number][] = [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45], [0.5, 0.6], [0.4, 0.5], [0.6, 0.5]];
  expect(await clickUntil(page, spots, async () => (await page.getByTestId('shelf-pick-hs1').count()) > 0)).toBe(true);
  await expect(page.getByTestId('placing-note')).toHaveCount(0);
  await settled(page);
  await expect(page.getByTestId('shelf-info')).toContainText(/Shelf 1: 160 × 100 × [\d.]+ mm, through \d+ plates/);
  await page.screenshot({ path: test.info().outputPath('shelf.png') });

  // a dinner candle, clicked onto whatever is under the middle of the view
  await page.getByRole('button', { name: 'Candelabra' }).click();
  await page.getByTestId('candle-place').click();
  await expect(page.getByTestId('placing-note')).toContainText('candle');
  expect(await clickUntil(page, spots, async () => (await page.getByTestId('placed-pc1').count()) > 0)).toBe(true);
  // still placing, so another click adds another; Esc stops
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('placing-note')).toHaveCount(0);
  await settled(page);
  await expect(page.getByTestId('placed-pc1')).toHaveAttribute('title', /Dinner candle \(taper\) on (a shelf|the plate tops|the concrete)/);
  await page.screenshot({ path: test.info().outputPath('candle.png') });
});
