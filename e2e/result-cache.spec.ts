import { test, expect, type Page } from '@playwright/test';
import { seedAllTourSeenKeys, waitForModelCurrent } from './map-helpers';
import { shadow8Json, vermilion93Json } from '../test/engine-fixtures';

// Plan A, PR 4: finished models come back from the result cache (undo, reload),
// one Settings button clears it, and a shadow edit shows the plates before the carve.

async function open(page: Page, projectJson: string) {
  await page.addInitScript(seedAllTourSeenKeys);
  await page.addInitScript((project) => {
    // only the first visit: a reload keeps what the session saved
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('strata.project.v1', project);
    localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: {}, ortho: false }));
  }, projectJson);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await waitForModelCurrent(page);
}

const app = (page: Page) => page.locator('.app.window');

/**
 * Clicks Undo or Redo and times it until the full model is on screen again, in ms
 * (page clock, from the DOM change itself: in a container without a GPU each
 * animation frame takes over a second to draw, so frames are not waited for).
 */
async function timedClick(page: Page, name: 'Undo' | 'Redo') {
  return page.evaluate(
    (name) =>
      new Promise<{ ms: number; cached: string | null; engineMs: number }>((resolve) => {
        const el = document.querySelector('.app.window')!;
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
        let left = false;
        const t0 = performance.now();
        const obs = new MutationObserver(() => {
          const current = el.getAttribute('data-strata-model-current') === '1';
          if (!current) left = true;
          else if (left) {
            obs.disconnect();
            resolve({ ms: performance.now() - t0, cached: el.getAttribute('data-strata-model-cached'), engineMs: Number(el.getAttribute('data-strata-model-ms')) });
          }
        });
        obs.observe(el, { attributes: true });
        btn.click();
      }),
    name,
  );
}

test('undo and redo come from the result cache; it survives reload and Settings clears it', async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, vermilion93Json());
  await expect(page.getByTestId('status-counts')).toContainText('93 plates');
  await page.waitForTimeout(3_000);
  const slider = page.getByRole('slider', { name: 'Erosion amplitude', exact: true }).first();
  await slider.scrollIntoViewIfNeeded();
  await slider.fill(String(Number(await slider.inputValue()) + 7));
  await expect(app(page)).toHaveAttribute('data-strata-model-current', '1', { timeout: 60_000 });
  await expect(app(page)).not.toHaveAttribute('data-strata-model-cached', /./);

  const undo = await timedClick(page, 'Undo');
  const redo = await timedClick(page, 'Redo');
  // onScreenMs includes drawing the 3D view, which without a GPU takes over a second a frame
  console.log(JSON.stringify({ undo: { engineMs: undo.engineMs, onScreenMs: Math.round(undo.ms) }, redo: { engineMs: redo.engineMs, onScreenMs: Math.round(redo.ms) } }));
  expect(undo.cached).toBe('memory');
  expect(redo.cached).toBe('memory');
  expect(undo.engineMs).toBeLessThan(100);
  expect(redo.engineMs).toBeLessThan(100);

  // reload: the first model on screen is read back from browser storage
  await page.reload();
  await page.waitForSelector('.app.window');
  await expect(app(page)).toHaveAttribute('data-strata-model-cached', 'disk', { timeout: 30_000 });
  await expect(page.getByTestId('status-counts')).toContainText('93 plates');

  // Settings › Clear saved results, then a reload builds again
  await page.getByRole('button', { name: /^Settings/ }).click();
  await expect(page.getByTestId('saved-results')).toContainText(/[1-9]\d* finished design/);
  await page.getByRole('button', { name: 'Clear saved results' }).click();
  await expect(page.getByTestId('saved-results')).toContainText('0 finished designs');
  await page.reload();
  await page.waitForSelector('.app.window');
  await waitForModelCurrent(page);
  await expect(app(page)).not.toHaveAttribute('data-strata-model-cached', /./);
});
