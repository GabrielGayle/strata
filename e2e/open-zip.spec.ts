import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './map-helpers';

const root = fileURLToPath(new URL('..', import.meta.url));
const zipPath = join(root, 'test/fixtures/projects/old-coarse-fabrication.zip');
const shotDir = join(root, 'docs/screenshots/projects');
const artifactDir = '/tmp/cursor/artifacts';

async function shot(page: Page, name: string) {
  await mkdir(shotDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: true });
  await page.screenshot({ path: join(artifactDir, `${name}.png`), fullPage: true }).catch(() => undefined);
}

test('open an older fabrication zip from Open and restore plate count', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await openApp(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Open', exact: true }).click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(async () => page.locator('[data-in-app-plates]').getAttribute('data-in-app-plates'), { timeout: 90_000 }).toBe('11');
  await expect(page.getByLabel('Project name')).toHaveValue('Coarse Oct 16');
  await expect(page.getByLabel('Plate count value')).toHaveValue('11');
  await shot(page, 'open-old-zip');
});
