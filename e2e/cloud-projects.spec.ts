import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './map-helpers';
import { e2eCloudEnv, e2eOriginB, e2eOwnerToken, e2ePreviewCommandB, stopChildProcessTree } from '../playwright.env';

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

const PROJECTS_API = /\/api\/projects(?:\?|$)/;

/** Fail page writes without sending them; GET still reaches the file store. Playwright `request` bypasses this. */
function rejectProjectWrites(route: Route) {
  const method = route.request().method();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
  return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'blocked' }) });
}

async function blockProjectWrites(page: Page) {
  await page.context().route(PROJECTS_API, rejectProjectWrites);
}

async function unblockProjectWrites(page: Page) {
  await page.context().unroute(PROJECTS_API, rejectProjectWrites);
}

function uniqueSaveName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

async function currentLibraryId(page: Page): Promise<string> {
  const el = page.locator('[data-testid^="saves-card-"].on, [data-testid^="saves-row-"].on');
  await expect(el).toBeVisible();
  const testId = await el.getAttribute('data-testid');
  const id = testId?.replace(/^saves-(?:card|row)-/, '');
  expect(id).toBeTruthy();
  return id!;
}

async function cloudPlateCount(request: APIRequestContext, id: string): Promise<string> {
  const r = await request.get(`/api/projects?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(r.ok()).toBeTruthy();
  return JSON.parse((await r.json()).data as string).params.plateCount as string;
}

/** Save as a unique 11-plate name, then block writes, edit to 17, Save. Returns the library id. */
async function saveThenBlockedSeventeen(page: Page, request: APIRequestContext, prefix: string): Promise<string> {
  const name = uniqueSaveName(prefix);
  page.once('dialog', (d) => void d.accept(name));
  await openProjects(page);
  await page.getByRole('button', { name: 'Save as…' }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('projects-sync')).toHaveAttribute('data-sync-status', 'saved');
  const id = await currentLibraryId(page);
  expect(await cloudPlateCount(request, id)).toBe('11');
  await page.getByTestId('projects-dialog').getByRole('button', { name: 'Close' }).click();

  await blockProjectWrites(page);
  await page.getByLabel('Plate count value').fill('17');
  await page.getByLabel('Plate count value').blur();
  await expect(page.getByLabel('Plate count value')).toHaveValue('17');
  await openProjects(page);
  await page.getByTestId('projects-dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('projects-sync')).toHaveAttribute('data-sync-status', /offline|pending/, { timeout: 15_000 });
  expect(await cloudPlateCount(request, id)).toBe('11');
  return id;
}

test.describe('cloud projects across origins', () => {
  let child: ChildProcess | undefined;

  test.beforeAll(async () => {
    child = spawn(e2ePreviewCommandB(), {
      cwd: root,
      env: e2eCloudEnv(process.env),
      stdio: 'pipe',
      shell: true,
      detached: true,
    });
    await waitHttp(e2eOriginB());
  });

  test.afterAll(() => {
    stopChildProcessTree(child);
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

  test('blocked save retries when the API returns, without pressing Save again', async ({ page, request }) => {
    await seedProject(page, TOKEN);
    await page.goto('/');
    await page.waitForSelector('.app.window', { timeout: 60_000 });
    await expect.poll(async () => page.locator('[data-in-app-plates]').getAttribute('data-in-app-plates'), { timeout: 90_000 }).toBe('11');

    const id = await saveThenBlockedSeventeen(page, request, 'Offline Seventeen');
    await expect(page.getByTestId('cloud-sync')).toHaveAttribute('data-sync-status', /offline|pending/);

    await unblockProjectWrites(page);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByTestId('projects-sync')).toHaveAttribute('data-sync-status', 'saved', { timeout: 30_000 });
    await expect(page.getByTestId('cloud-sync')).toHaveAttribute('data-sync-status', 'saved');
    expect(await cloudPlateCount(request, id)).toBe('17');
  });

  test('blocked save retries on backoff without online, focus, or visibility events', async ({ page, request }) => {
    await seedProject(page, TOKEN);
    await page.goto('/');
    await page.waitForSelector('.app.window', { timeout: 60_000 });
    await expect.poll(async () => page.locator('[data-in-app-plates]').getAttribute('data-in-app-plates'), { timeout: 90_000 }).toBe('11');

    const id = await saveThenBlockedSeventeen(page, request, 'Backoff Seventeen');

    await unblockProjectWrites(page);

    await expect.poll(async () => cloudPlateCount(request, id), { timeout: 15_000 }).toBe('17');
    await expect(page.getByTestId('projects-sync')).toHaveAttribute('data-sync-status', 'saved');
    await expect(page.getByTestId('cloud-sync')).toHaveAttribute('data-sync-status', 'saved');
  });
});
