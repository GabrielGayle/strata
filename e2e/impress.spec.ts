import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { openApp } from './map-helpers';

// Impress image: pick a picture, click it onto the top surface, then move, size,
// turn and deepen it with the in-view gizmo; every handle edit is one undo step.

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** A black disc on white, 120 × 80. */
function discPng(): Buffer {
  const png = new PNG({ width: 120, height: 80 });
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 120; x++) {
      const i = (y * 120 + x) * 4;
      const c = Math.hypot(x - 60, y - 40) < 30 ? 0 : 255;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = c;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

type Handles = Record<'move' | 'scale' | 'turn' | 'depth', [number, number]>;
/** Where the gizmo's handles are on screen, once they have stopped moving (the model rebuilds after each edit). */
async function handles(page: Page): Promise<Handles> {
  const view = page.getByTestId('impress-view');
  await expect(view).toHaveAttribute('data-handles', /move/);
  let last = '';
  await expect
    .poll(
      async () => {
        const now = (await view.getAttribute('data-handles'))!;
        const same = now === last;
        last = now;
        return same;
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(true);
  return JSON.parse(last);
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  // at a hand's pace: software WebGL draws a frame or two a second here
  for (let k = 1; k <= 6; k++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * k) / 6, from[1] + ((to[1] - from[1]) * k) / 6);
    await page.waitForTimeout(150);
  }
  await page.mouse.up();
}

const value = (page: Page, id: string) => page.getByTestId(id).inputValue().then(Number);

test('a picture is clicked onto the top surface and moved, sized, turned and deepened with the gizmo', async ({ page }) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = watchErrors(page);
  await openApp(page);
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-model-current', '1', { timeout: 120_000 });
  await page.getByTestId('impress-open').click();
  await expect(page.getByTestId('impress-view')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('impress-hint')).toContainText('Pick a picture');

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('impress-pick').click();
  await (await chooser).setFiles({ name: 'disc.png', mimeType: 'image/png', buffer: discPng() });
  await expect(page.getByTestId('impress-hint')).toContainText('Click the top surface', { timeout: 30_000 });

  const box = (await page.locator('.impress-view canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await expect(page.getByTestId('impress-selected')).toBeVisible();
  await expect(page.locator('.impress-list li')).toHaveCount(1);

  // move: the picture follows the pointer
  const h0 = await handles(page);
  await drag(page, h0.move, [h0.move[0] + 60, h0.move[1]]);
  expect((await handles(page)).move[0] - h0.move[0]).toBeGreaterThan(30);

  // size: pulling a corner away from the centre widens it
  const w0 = await value(page, 'impress-width');
  const h1 = await handles(page);
  await drag(page, h1.scale, [h1.scale[0] + (h1.scale[0] - h1.move[0]), h1.scale[1] + (h1.scale[1] - h1.move[1])]);
  await expect.poll(() => value(page, 'impress-width'), { timeout: 15_000 }).toBeGreaterThan(w0 * 1.2);

  // turn: the round handle swings it round its centre
  const h2 = await handles(page);
  await drag(page, h2.turn, [h2.turn[0] + 80, h2.turn[1] + 30]);
  await expect.poll(async () => Math.abs(await value(page, 'impress-turn')), { timeout: 15_000 }).toBeGreaterThan(10);

  // depth: the slider, then the arrow
  const d0 = await value(page, 'impress-depth');
  await page.getByTestId('impress-depth').focus();
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
  }
  await expect.poll(() => value(page, 'impress-depth')).toBeGreaterThan(d0);
  await expect(page.locator('.impress-list .impress-depth')).not.toHaveText(`${d0.toFixed(1)} mm`);

  // x-ray off and on again, then Delete removes the picture
  await page.getByTestId('impress-xray').uncheck();
  await page.getByTestId('impress-xray').check();
  await page.locator('.impress-list .impress-name').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.impress-list li')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Depth from photo swaps a picture for its depth relief and back, asking the server once', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = watchErrors(page);
  // the depth server, answering with a grey relief (an older-style answer: picture only)
  let asked = 0;
  const relief = `data:image/png;base64,${discPng().toString('base64')}`;
  await page.route(/strata-depth|\/strata$/, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 405, body: '' });
    asked++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ png: relief, width: 120, height: 80 }) });
  });
  await openApp(page);
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-model-current', '1', { timeout: 120_000 });
  await page.getByTestId('impress-open').click();
  await expect(page.getByTestId('impress-view')).toBeVisible({ timeout: 30_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('impress-pick').click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: discPng() });
  await expect(page.getByTestId('impress-hint')).toContainText('Click the top surface', { timeout: 30_000 });
  const box = (await page.locator('.impress-view canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);

  const toggle = page.getByTestId('impress-photo-depth');
  // the switch turns on once the server has answered, so click rather than check
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 30_000 });
  expect(asked).toBe(1);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(asked).toBe(1);
  expect(errors).toEqual([]);
});
