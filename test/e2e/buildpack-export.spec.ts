import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliffProject = readFileSync(join(root, 'examples/image-cliff.strata.json'), 'utf8');
const neasdenProject = readFileSync(join(root, 'test/fixtures/projects/neasden-buildpack.strata.json'), 'utf8');

async function injectProject(page: import('@playwright/test').Page, projectJson: string) {
  await page.addInitScript((json) => {
    localStorage.setItem('strata.project.v1', json);
  }, projectJson);
}

function listingFromZip(buf: Buffer, plateCount: number): string {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).sort();
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  const lines = [
    `modelPlateCount=${plateCount}`,
    `manifestPlateCount=${manifest.plateCount}`,
    `zipFileCount=${names.length}`,
    '',
    ...names,
  ];
  return lines.join('\n') + '\n';
}

test('browser export: Neasden map job', async ({ page }) => {
  await injectProject(page, neasdenProject);
  await page.goto('/');
  await page.getByRole('button', { name: 'Export ZIP' }).waitFor({ state: 'visible' });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  const manifest = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(buf))['manifest.json']));
  expect(manifest.plateCount).toBe(12);
  mkdirSync(join(root, 'docs/buildpack-verify'), { recursive: true });
  writeFileSync(join(root, 'docs/buildpack-verify/neasden-map-zip.txt'), listingFromZip(buf, 12));
});

test('browser export: image cliff job', async ({ page }) => {
  await injectProject(page, cliffProject);
  await page.goto('/');
  await page.getByRole('button', { name: 'Export ZIP' }).waitFor({ state: 'visible' });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByRole('button', { name: 'Export ZIP' }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  const manifest = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(buf))['manifest.json']));
  expect(manifest.plateCount).toBe(24);
  mkdirSync(join(root, 'docs/buildpack-verify'), { recursive: true });
  writeFileSync(join(root, 'docs/buildpack-verify/image-cliff-zip.txt'), listingFromZip(buf, 24));
});
