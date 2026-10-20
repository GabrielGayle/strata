import { test, expect, type Page } from '@playwright/test';
import { loadPreset } from './map-helpers';

// Movable panels and controls (Layout menu): a move survives a reload, a saved
// layout comes back, and Reset puts everything where it started.

const panelOf = (page: Page, param: string) => page.locator(`[data-param="${param}"]`).first().evaluate((e) => e.closest('fieldset')?.getAttribute('data-panel'));
const columnOf = (page: Page, panel: string) => page.locator(`[data-panel="${panel}"]`).evaluate((e) => e.closest('aside')?.getAttribute('data-column'));

async function open(page: Page) {
  await page.goto('/');
  await page.waitForSelector('[data-column="a"] fieldset.section', { timeout: 60_000 });
}

test('panels and controls move, stay moved, save and reset', async ({ page }) => {
  // tall enough that the dragged grip and its drop spot are both on screen
  await page.setViewportSize({ width: 1500, height: 2200 });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Mine' : undefined));
  await open(page);

  await page.locator('[data-hl="edit-layout-toggle"]').click();
  await page.locator('[data-grip-control="baseLength"]').dragTo(page.locator('fieldset[data-group="Master"] .section-body'));
  await expect.poll(() => panelOf(page, 'baseLength')).toBe('param:Master');
  await expect(page.locator('[data-ctl="baseLength"] .ctl-from')).toContainText('from Base');

  // keyboard: a panel's grip takes it to the other column with Left / Right
  await page.locator('[data-grip-panel="insp:export"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => columnOf(page, 'insp:export')).toBe('a');

  // a panel of your own
  await page.locator('[data-hl="menu-layout"]').click();
  await page.locator('[data-hl="new-panel"]').click();
  await page.locator('[data-grip-control="baseWidth"]').dragTo(page.locator('.custom-panel .section-body'));
  await expect.poll(() => panelOf(page, 'baseWidth')).toMatch(/^custom:/);

  // kept across a reload
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('[data-column="a"] fieldset.section', { timeout: 60_000 });
  expect(await panelOf(page, 'baseLength')).toBe('param:Master');
  expect(await columnOf(page, 'insp:export')).toBe('a');
  await expect(page.locator('.custom-panel legend')).toContainText('Mine');

  // save it, reset, and load it back
  await page.locator('[data-hl="menu-layout"]').click();
  await page.locator('[data-hl="layout-save"]').click();
  await page.locator('[data-hl="menu-layout"]').click();
  await page.locator('[data-hl="layout-reset"]').click();
  await expect.poll(() => panelOf(page, 'baseLength')).toBe('param:Base');
  expect(await columnOf(page, 'insp:export')).toBe('b');
  await expect(page.locator('.custom-panel')).toHaveCount(0);

  await page.locator('[data-hl="menu-layout"]').click();
  await page.locator('[data-hl="layout-saved"]').filter({ hasText: 'Mine' }).click();
  await expect.poll(() => panelOf(page, 'baseLength')).toBe('param:Master');
  expect(await columnOf(page, 'insp:export')).toBe('a');
});

test('Show me finds a control after it has moved', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await loadPreset(page, 'Vermilion 40');
  // step the control up out of its own panel into the one above it
  await page.getByLabel('Filter parameters').fill('minPartSize');
  await page.locator('[data-hl="edit-layout-toggle"]').click();
  const home = await panelOf(page, 'minPartSize');
  await page.locator('[data-grip-control="minPartSize"]').focus();
  for (let i = 0; i < 40 && (await panelOf(page, 'minPartSize')) === home; i++) await page.keyboard.press('ArrowUp');
  const moved = await panelOf(page, 'minPartSize');
  expect(moved).not.toBe(home);
  await page.getByLabel('Filter parameters').fill('');
  await page.locator('[data-hl="edit-layout-toggle"]').click();
  // fold the panel it sits in now: Show me must unfold that one, not its old home
  const head = page.locator(`fieldset[data-panel="${moved}"] button.section-head`);
  if ((await head.getAttribute('aria-expanded')) === 'true') await head.click();
  await expect(page.locator('[data-param="minPartSize"]')).toHaveCount(0);

  await page.locator('[data-hl="menu-help"]').click();
  await page.locator('[data-hl="help-changelog"]').click();
  await page.getByTestId('changelog').getByRole('button', { name: /Clearer small-part warning/ }).click();
  await expect(page.getByTestId('changelog-spotlight')).toHaveAttribute('data-state', 'found', { timeout: 10_000 });
  await expect(page.locator('[data-param="minPartSize"]')).toBeVisible();
  expect(await panelOf(page, 'minPartSize')).toBe(moved);
});
