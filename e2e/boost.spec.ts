// Boost (plan PR 8): off by default with no /api/geo request; on, the Cloud field says where it
// stands, a map with "High resolution (cloud)" builds on the cloud, and any cloud trouble falls
// back to the local build with a toast.
import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { e2eOwnerToken } from '../playwright.env';
import { dismissTour, openApp, openWorkspaceTab, pickNeasdenPreset, waitForMapReady } from './map-helpers';

function countGeo(page: Page): { n: number } {
  const seen = { n: 0 };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/geo')) seen.n++;
  });
  return seen;
}

async function boostOn(page: Page) {
  const token = e2eOwnerToken();
  await page.addInitScript((t) => {
    localStorage.setItem('strata.boost', 'on');
    localStorage.setItem('strata.owner.token', t);
  }, token);
}

async function tickCloudRes(page: Page) {
  await openWorkspaceTab(page, 'Map');
  await page.getByTestId('map-cloud-res').check();
}

test('Boost is off by default and makes no /api/geo request', async ({ page }) => {
  const geo = countGeo(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: off');
  await pickNeasdenPreset(page);
  await openWorkspaceTab(page, 'Map');
  await expect(page.getByTestId('map-cloud-res')).toHaveCount(0);
  await page.getByRole('button', { name: /^Settings/ }).click();
  await expect(page.getByTestId('boost-toggle')).not.toBeChecked();
  expect(geo.n).toBe(0);
});

test('Boost without the owner passphrase is locked, still with no request', async ({ page }) => {
  const geo = countGeo(page);
  await openApp(page);
  await page.getByRole('button', { name: /^Settings/ }).click();
  await page.getByTestId('boost-toggle').check();
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: locked');
  expect(geo.n).toBe(0);
});

test('Boost on a server without Modal rests, and the map builds here with a toast', async ({ page }) => {
  await boostOn(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: resting: not set up');
  await pickNeasdenPreset(page);
  await tickCloudRes(page);
  await expect(page.locator('.toast')).toContainText('Cloud not set up: building the map here at 1024 px instead');
  await waitForMapReady(page);
});

test('Boost offline falls back to the local build with a toast', async ({ page }) => {
  await page.route('**/api/geo/**', (r) => r.abort('internetdisconnected'));
  await boostOn(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: resting: offline');
  await pickNeasdenPreset(page);
  await tickCloudRes(page);
  await expect(page.locator('.toast')).toContainText('Cloud offline: building the map here at 1024 px instead');
  await waitForMapReady(page);
});

/** A small real terrain asset from the engine (a cone), standing in for a cloud result. */
function coneAsset(): Record<string, unknown> {
  const code = `
    import { syntheticConeGrid, mapGridToDepth } from './src/core/mapToDepth';
    const g = syntheticConeGrid(96, 400, 80);
    const { depth } = mapGridToDepth(g, { exaggeration: 4 });
    process.stdout.write(JSON.stringify(depth));
  `;
  const depth = JSON.parse(execFileSync('npx', ['tsx', '--input-type=module', '-e', code], { encoding: 'utf8' }));
  return depth;
}

test('Boost builds a map on the cloud: working n%, then the cloud grid lands', async ({ page }) => {
  const depth = coneAsset();
  const key = 'c'.repeat(32);
  let polls = 0;
  let posted: { spec: Record<string, unknown> } | null = null;
  let artifact: Buffer | null = null;
  await page.route('**/api/geo/**', async (route: Route) => {
    const req = route.request();
    expect(req.headers()['authorization']).toBe(`Bearer ${e2eOwnerToken()}`);
    const path = new URL(req.url()).pathname.replace('/api/geo/', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'health') return json({ ok: true, engine: null });
    if (path === 'usage') return json({ month: '2026-10', jobs: 1, estimateUsd: 0.0014, workspaceUsd: null, grantUsd: 30 });
    if (path === 'jobs' && req.method() === 'POST') {
      posted = req.postDataJSON();
      const spec = posted!.spec;
      artifact = gzipSync(JSON.stringify({ name: 'Neasden', dataUrl: '', map: { ...spec, kind: 'map', cloudBuilt: { key, px: 96 } }, depth }));
      return json({ id: 'fc-e2e', status: 'running', progress: 0, key }, 202);
    }
    if (path === 'jobs/fc-e2e') {
      polls++;
      return json(polls < 3 ? { id: 'fc-e2e', status: 'running', progress: 0.5, stage: 'resample' } : { id: 'fc-e2e', status: 'done', key, px: 96 });
    }
    if (path === `artifacts/${key}`) {
      // two parts, as a big result would come
      const part = Number(new URL(req.url()).searchParams.get('part'));
      const half = Math.ceil(artifact!.length / 2);
      return route.fulfill({ status: 200, headers: { 'X-Strata-Parts': '2', 'Content-Type': 'application/octet-stream' }, body: artifact!.subarray(part * half, (part + 1) * half) });
    }
    return json({ error: 'not found' }, 404);
  });
  await boostOn(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: ready');
  await pickNeasdenPreset(page);
  await tickCloudRes(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: working 50%');
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: ready');
  await waitForMapReady(page);
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-grid', '96x96');
  expect(posted!).toMatchObject({ kind: 'terrain', maxPx: 2048, spec: { kind: 'map', source: expect.any(String) } });
  expect(posted!.spec).not.toHaveProperty('cloudRes');
  await page.getByRole('button', { name: /^Settings/ }).click();
  await expect(page.getByTestId('boost-usage')).toContainText('2026-10: 1 job');
  // unticking goes back to the local grid
  await page.keyboard.press('Escape');
  await dismissTour(page);
  await openWorkspaceTab(page, 'Map');
  await page.getByTestId('map-cloud-res').uncheck();
  await waitForMapReady(page);
  await expect(page.locator('.app.window')).not.toHaveAttribute('data-strata-map-grid', '96x96');
});

test('a cloud job that fails falls back to the local build with a toast', async ({ page }) => {
  await page.route('**/api/geo/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/geo/', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'health') return json({ ok: true, engine: null });
    if (path === 'jobs') return json({ id: 'fc-old', status: 'running', progress: 0, key: 'd'.repeat(32) }, 202);
    if (path === 'jobs/fc-old') return json({ id: 'fc-old', status: 'failed', reason: 'out-of-date', error: 'redeploy the worker' });
    return json({}, 404);
  });
  await boostOn(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: ready');
  await pickNeasdenPreset(page);
  const local = await page.locator('.app.window').getAttribute('data-strata-map-grid');
  await tickCloudRes(page);
  await expect(page.locator('.toast')).toContainText('Cloud worker out of date: building the map here at 1024 px instead');
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: resting: worker out of date');
  await waitForMapReady(page);
  await expect(page.locator('.app.window')).toHaveAttribute('data-strata-map-grid', local!);
});

/**
 * A cloud stand-in for the pack job: asks for the design, keeps the uploaded parts, and
 * answers with the real `runPackJob` zip of that design (with the fault, when asked).
 */
async function packCloud(page: Page, opts: { fault: boolean }) {
  const parts: Buffer[] = [];
  const key = 'e'.repeat(32);
  let zip: Buffer | null = null;
  let posted: Record<string, unknown> | null = null;
  await page.route('**/api/geo/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/geo/', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'health') return json({ ok: true, engine: null });
    if (path === 'usage') return json({ month: '2026-10', jobs: 0, estimateUsd: 0, workspaceUsd: null, grantUsd: 30 });
    if (path === 'jobs' && req.method() === 'POST') {
      posted = req.postDataJSON();
      const input = posted!.input as { parts: number };
      if (parts.filter(Boolean).length < input.parts) return json({ error: 'Upload the design first', reason: 'needs-input', missing: [0] }, 409);
      return json({ id: 'fc-pack', status: 'running', progress: 0, key }, 202);
    }
    if (path.startsWith('inputs/') && req.method() === 'POST') {
      parts[Number(url.searchParams.get('part'))] = Buffer.from(req.postDataJSON().data, 'base64');
      return json({ ok: true });
    }
    if (path === 'jobs/fc-pack') {
      if (!zip) {
        const dir = mkdtempSync(join(tmpdir(), 'strata-e2e-pack-'));
        writeFileSync(join(dir, 'design.json'), gunzipSync(Buffer.concat(parts)));
        writeFileSync(join(dir, 'req.json'), JSON.stringify(posted));
        const code = `
          import { readFileSync, writeFileSync } from 'node:fs';
          import { runPackJob } from './src/cloudJobs';
          const r = await runPackJob(JSON.parse(readFileSync(${JSON.stringify(join(dir, 'req.json'))}, 'utf8')), readFileSync(${JSON.stringify(join(dir, 'design.json'))}, 'utf8'), { allowFaults: true });
          writeFileSync(${JSON.stringify(join(dir, 'pack.zip'))}, r.zip);
        `;
        execFileSync('npx', ['tsx', '--input-type=module', '-e', code], { encoding: 'utf8' });
        zip = readFileSync(join(dir, 'pack.zip'));
      }
      return json({ id: 'fc-pack', status: 'done', key, seconds: 6.6, costUsd: 0.00023 });
    }
    if (path === `artifacts/${key}/pack.zip`) {
      return route.fulfill({ status: 200, headers: { 'X-Strata-Parts': '1', 'Content-Type': 'application/octet-stream' }, body: zip! });
    }
    return json({ error: 'not found' }, 404);
  });
  await page.addInitScript((fault) => {
    if (fault) localStorage.setItem('strata.cloudFault', 'drop-plate');
  }, opts.fault);
  return { posted: () => posted };
}

test('Export (cloud) uploads the design and shows a download link once the pack matches it', async ({ page }) => {
  const cloud = await packCloud(page, { fault: false });
  await boostOn(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: ready');
  await page.getByTestId('cloud-pack').click();
  await expect(page.getByTestId('cloud-pack-link')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('cloud-notice')).toContainText(/matching this design/);
  expect(cloud.posted()).toMatchObject({ kind: 'pack', input: { parts: 1 }, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(cloud.posted()).not.toHaveProperty('fault');
});

test('a cloud pack missing a plate is a red error with no download (dev fault switch)', async ({ page }) => {
  const cloud = await packCloud(page, { fault: true });
  await boostOn(page);
  await openApp(page);
  await expect(page.getByTestId('cloud-status')).toHaveText('Cloud: ready');
  await page.getByTestId('cloud-pack').click();
  await expect(page.getByTestId('cloud-notice')).toContainText(/Cloud pack refused: the cloud pack has \d+ plates and this design has \d+/, { timeout: 120_000 });
  await expect(page.getByTestId('cloud-pack-link')).toHaveCount(0);
  expect(cloud.posted()).toMatchObject({ fault: 'drop-plate' });
});
