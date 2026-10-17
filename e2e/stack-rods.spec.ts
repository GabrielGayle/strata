import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { seedAllTourSeenKeys } from './map-helpers';
import { stackRodsProjectJson } from '../test/stack-rods-fixture';

const SHOT = join(process.cwd(), 'docs/screenshots/stack-rods');

async function seed(page: Page) {
  await page.addInitScript(seedAllTourSeenKeys);
  await page.addInitScript((project) => {
    localStorage.setItem('strata.project.v1', project);
    localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: { Slicer: false }, ortho: true }));
  }, stackRodsProjectJson());
}

async function waitReady(page: Page) {
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await expect(page.getByTestId('status-counts')).toContainText(/\d+\s+plates/, { timeout: 90_000 });
  await expect
    .poll(async () => Number(await page.locator('.app.window').getAttribute('data-strata-stack-rods')), { timeout: 90_000 })
    .toBeGreaterThan(0);
}

test.describe('support poles on a Stamped two-peak stack', () => {
  test('shows rods in 3D with a toggle', async ({ page }) => {
    await mkdir(SHOT, { recursive: true });
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitReady(page);

    await expect(page.locator('.app.window')).toHaveAttribute('data-strata-slice-mode', 'flat');
    const root = page.locator('.app.window');
    await expect(root).toHaveAttribute('data-strata-stack-rods-visible', '1');

    await page.locator('.ws-tabs').getByRole('tab', { name: '3D' }).click();
    const view3d = page.getByTestId('viewport-3d');
    await expect(view3d.locator('canvas')).toBeVisible({ timeout: 15_000 });
    const toolbar = page.getByTestId('viewport-layers');
    const rodsBtn = toolbar.getByTestId('viewport-layer-rods');
    await expect(rodsBtn).toBeVisible();
    await expect(rodsBtn).toHaveClass(/on/);

    await view3d.screenshot({ path: join(SHOT, '3d-plates-and-rods.png') });

    await toolbar.getByRole('button', { name: 'Plates' }).click();
    await expect(toolbar.getByRole('button', { name: 'Plates' })).not.toHaveClass(/on/);
    await expect(root).toHaveAttribute('data-strata-stack-rods-visible', '1');
    await view3d.screenshot({ path: join(SHOT, '3d-rods-only.png') });

    await rodsBtn.click();
    await expect(rodsBtn).not.toHaveClass(/on/);
    await expect(root).toHaveAttribute('data-strata-stack-rods-visible', '0');
    await view3d.screenshot({ path: join(SHOT, '3d-rods-off.png') });

    await rodsBtn.click();
    await expect(root).toHaveAttribute('data-strata-stack-rods-visible', '1');

    const poles = page.getByTestId('inspector-support-poles');
    await expect(poles).toBeVisible();
    await expect(poles).toContainText('R1');
    await expect(poles).toContainText('Ø6');
    await poles.screenshot({ path: join(SHOT, 'inspector-support-poles.png') });

    await page.getByLabel('Filter parameters').fill('Support poles');
    await expect(page.locator('#param-stackRodsOn')).toBeChecked();
    await page.locator('[data-group="Slicer"]').screenshot({ path: join(SHOT, 'slicer-support-poles.png') });
  });
});
