import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './map-helpers';
import { e2eOwnerToken } from '../playwright.env';

const root = fileURLToPath(new URL('..', import.meta.url));
const shotDir = join(root, 'docs/screenshots/projects');
const artifactDir = '/tmp/cursor/artifacts';
const TOKEN = e2eOwnerToken();

async function shot(page: Page, name: string) {
  await mkdir(shotDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: true });
  await page.screenshot({ path: join(artifactDir, `${name}.png`), fullPage: true }).catch(() => undefined);
}

test('Save and Export ZIP land in the saves browser', async ({ page }) => {
  await page.addInitScript((t) => {
    localStorage.setItem('strata:tour-seen', '1');
    localStorage.setItem('strata.owner.token', t);
  }, TOKEN);
  await openApp(page);
  page.on('dialog', (d) => void d.accept());

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByTestId('saves-browser')).toBeVisible();
  await expect(page.getByText('Vermilion 40').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Vermilion/).first()).toBeVisible();
  await shot(page, 'saves-browser-grid');

  await page.getByTestId('saves-view-list').click();
  await expect(page.getByTestId('saves-view-list')).toHaveClass(/on/);
  await page.getByTestId('saves-search').fill('vermilion');
  await expect(page.getByText('Vermilion 40').first()).toBeVisible();
  await shot(page, 'saves-browser-list');

  await page.getByTestId('projects-dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('left-saves-tab').click();
  await expect(page.getByTestId('saves-panel')).toBeVisible();
  await expect(page.getByTestId('saves-panel').getByText('Vermilion 40').first()).toBeVisible();
  await shot(page, 'saves-side-panel');
});
