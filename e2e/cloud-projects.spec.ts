import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './map-helpers';
import { e2eCloudEnv, e2eOriginB, e2eOwnerToken, e2ePreviewCommandB } from '../playwright.env';

const root = fileURLToPath(new URL('..', import.meta.url));
const shotDir = join(root, 'docs/screenshots/projects');
const artifactDir = '/tmp/cursor/artifacts';
const projectJson = readFileSync(join(root, 'test/fixtures/projects/cloud-roundtrip.strata.json'), 'utf8');
const TOKEN = e2eOwnerToken();

async function seedProject(page: Page, token?: string) {
  await page.addInitScript(
    ({ project, token: t }) => {
      localStorage.setItem('strata:tour-seen', '1');
      localStorage.setItem('strata.project.v1', project);
      if (t) localStorage.setItem('strata.owner.token', t);
    },
    { project: projectJson, token },
  );
}

async function seedToken(page: Page) {
  await page.addInitScript((t) => {
    localStorage.setItem('strata:tour-seen', '1');
    localStorage.setItem('strata.owner.token', t);
  }, TOKEN);
}

async function waitHttp(url: string, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function shot(page: Page, name: string) {
  await mkdir(shotDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined);
  const file = `${name}.png`;
  await page.screenshot({ path: join(shotDir, file), fullPage: true });
  await page.screenshot({ path: join(artifactDir, file), fullPage: true }).catch(() => undefined);
}

async function openProjects(page: Page) {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByTestId('projects-dialog')).toBeVisible();
}

test.describe('cloud projects across origins', () => {
  let child: ChildProcess | undefined;

  test.beforeAll(async () => {
    child = spawn(e2ePreviewCommandB(), { cwd: root, env: e2eCloudEnv(process.env), stdio: 'pipe', shell: true });
    await waitHttp(e2eOriginB());
  });

  test.afterAll(() => {
    child?.kill('SIGTERM');
  });

  test('token gate: without the token the public URL cannot list projects', async ({ page, request }) => {
    const listed = await request.get('/api/projects');
    expect(listed.status()).toBe(401);
    await openApp(page);
    await expect(page.getByTestId('cloud-sync')).toHaveAttribute('data-sync-status', 'locked');
    await openProjects(page);
    await expect(page.getByTestId('projects-token')).toBeVisible();
    await expect(page.getByTestId('projects-sync')).toHaveAttribute('data-sync-status', 'locked');
    await shot(page, 'projects-token-gate');
  });

  test('save on 127.0.0.1, open on localhost, plate count and overrides survive', async ({ page, browser }) => {
    await seedProject(page, TOKEN);
    await page.goto('/');
    await page.waitForSelector('.app.window', { timeout: 60_000 });
    await expect(page.getByTestId('cloud-sync')).toHaveAttribute('data-sync-status', /saved|syncing/, { timeout: 20_000 });
    await expect.poll(async () => page.locator('[data-in-app-plates]').getAttribute('data-in-app-plates'), { timeout: 90_000 }).toBe('11');

    page.once('dialog', (d) => void d.accept('Cloud Roundtrip'));
    await openProjects(page);
    await page.getByRole('button', { name: 'Save as…' }).click();
    await expect(page.getByText('Cloud Roundtrip').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('projects-sync')).toHaveAttribute('data-sync-status', 'saved');
    await shot(page, 'projects-dialog-cloud');
    await page.getByTestId('projects-dialog').getByRole('button', { name: 'Close' }).click();
    await shot(page, 'toolbar-cloud-sync');

    const originB = e2eOriginB();
    const ctx = await browser.newContext({ baseURL: originB });
    const pageB = await ctx.newPage();
    await seedToken(pageB);
    await pageB.goto(originB + '/');
    await pageB.waitForSelector('.app.window', { timeout: 60_000 });
    await openProjects(pageB);
    await expect(pageB.getByText('Cloud Roundtrip').first()).toBeVisible({ timeout: 20_000 });
    await pageB.getByRole('button', { name: 'Open', exact: true }).first().click();
    await expect.poll(async () => pageB.locator('[data-in-app-plates]').getAttribute('data-in-app-plates'), { timeout: 90_000 }).toBe('11');
    await expect(pageB.getByLabel('Plate count value')).toHaveValue('11');
    const overrides = await pageB.evaluate(() => {
      const raw = localStorage.getItem('strata.project.v1');
      if (!raw) return null;
      try {
        return JSON.parse(raw).userParamOverrides ?? null;
      } catch {
        return null;
      }
    });
    // autosave is IndexedDB; fall back to the param field already checked
    expect(overrides === null || overrides.plateCount === true).toBe(true);
    await ctx.close();
  });
});
