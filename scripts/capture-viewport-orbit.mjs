/**
 * Orbit the 3D viewport and save PNG frames (no video).
 * Usage:
 *   npm run build && node scripts/capture-viewport-orbit.mjs after default
 *   npm run build && node scripts/capture-viewport-orbit.mjs after map-x21-frame
 * map-x21-frame uses the live network (no VITE_E2E_MAP_FIXTURES). Build without that env.
 * preset: default | map-x21-frame | map-x18-frame (alias of map-x21-frame)
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}/`;
const phase = process.argv[2] === 'after' ? 'after' : 'before';
const presetArg = process.argv[3] ?? 'default';
const preset = presetArg === 'map-x18-frame' ? 'map-x21-frame' : presetArg;
const OUT = path.join(root, 'docs/screenshots/viewport', phase, preset);

async function expectStatusReady(page, timeout = 240000) {
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.status-bar')?.textContent ?? '';
      return /ready/i.test(t) || /(\d+)\s+parts/.test(t);
    },
    { timeout },
  );
}

function waitForUrl(url, ms = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {
        /* retry */
      }
      if (Date.now() - start > ms) reject(new Error(`Preview not up at ${url}`));
      else setTimeout(tick, 400);
    };
    tick();
  });
}

function seedAllTourSeenKeys() {
  try {
    const keys = new Set(['strata:tour-seen']);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /tour-seen/i.test(k)) keys.add(k);
    }
    for (const k of keys) localStorage.setItem(k, '1');
  } catch {
    /* ignore */
  }
}

async function dismissTour(page) {
  const dlg = page.getByRole('dialog', { name: /Tour:/ });
  for (let n = 0; n < 8; n++) {
    const visible = await dlg
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      await dlg.getByRole('button', { name: 'Skip' }).click();
      await dlg.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      continue;
    }
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      continue;
    }
    return;
  }
}

async function waitForViewportCanvas(page) {
  await page.waitForSelector('[data-testid="viewport-3d"] canvas', { timeout: 120000 });
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="viewport-3d"] canvas');
    return !!c && c.clientWidth > 80 && c.clientHeight > 80;
  }, { timeout: 120000 });
  await page.waitForTimeout(800);
}

async function show3dTab(page) {
  const tab3d = page.getByRole('tab', { name: /^3D$/i });
  if (await tab3d.count()) await tab3d.click();
  else await page.keyboard.press('1');
}

async function waitMapReady(page, readoutNeedle) {
  await page
    .waitForFunction(
      () =>
        !!document.querySelector('.map-terrain-working') ||
        /Fetching|building|Queued/i.test(document.querySelector('.map-terrain-status')?.textContent ?? '') ||
        /Fetching|building/i.test(document.querySelector('.status-bar')?.textContent ?? ''),
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForFunction(
    (needle) => {
      if (document.querySelector('.map-terrain-working')) return false;
      const st = document.querySelector('.map-terrain-status')?.textContent ?? '';
      const bar = document.querySelector('.status-bar')?.textContent ?? '';
      if (/Fetching|building|Queued/i.test(st) && !/ready/i.test(st)) return false;
      if (/Fetching|building/i.test(bar) && !/ready/i.test(bar)) return false;
      if (needle && !st.includes(needle)) return false;
      return /Map terrain ready|Exaggeration/i.test(st);
    },
    readoutNeedle ?? '',
    { timeout: 240000 },
  );
}

async function setupPage(page, presetId) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('.app.window', { timeout: 120000 });
  await dismissTour(page);
  await expectStatusReady(page);

  if (presetId === 'map-x21-frame' || presetId === 'map-x18-frame') {
    console.log('map: Presets › Stamped stack (flat layers + top carve)');
    await page.getByRole('button', { name: /Presets/i }).click();
    await page.getByRole('button', { name: /Stamped stack/i }).click();
    await expectStatusReady(page, 120000);

    console.log('map: opening Map tab');
    await page.getByRole('button', { name: /Maps/i }).click();
    await page.getByRole('button', { name: /Open Map tab/i }).click();
    await page.waitForSelector('.map-view', { timeout: 60000 });
    console.log('map: Neasden preset');
    await page.locator('.map-view').getByRole('button', { name: 'Neasden', exact: true }).click();
    await waitMapReady(page, 'Exaggeration');
    console.log('map: set ×21 + sunken frame');
    await page.getByLabel('Vertical exaggeration').selectOption('21');
    await waitMapReady(page, '×21');
    await page.locator('label').filter({ hasText: 'Sunken concrete frame' }).locator('input[type=checkbox]').check({ force: true });
    await waitMapReady(page, '×21');
    console.log('map: back to 3D');
    await show3dTab(page);
    await waitForViewportCanvas(page);
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.overlay.bl.info')?.textContent ?? '';
        return /layers/i.test(t) && /face to face/i.test(t);
      },
      undefined,
      { timeout: 180000 },
    );
    await page.getByRole('button', { name: 'Iso', exact: true }).click().catch(() => {});
    await page.waitForTimeout(2500);
    return;
  }

  await waitForViewportCanvas(page);
  await page.waitForTimeout(1500);
}

async function clipScreenshot(page, filePath) {
  const canvas = page.locator('[data-testid="viewport-3d"] canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 120000 });
  const box = await canvas.boundingBox();
  if (!box || box.width < 40 || box.height < 40) throw new Error('No canvas bounding box');
  // WebGL canvases never go "stable" under rAF; clip the page instead of locator.screenshot().
  await page.screenshot({
    path: filePath,
    type: 'jpeg',
    quality: 68,
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, 1600),
      height: Math.min(box.height, 1200),
    },
  });
}

async function orbitFrames(page, outDir) {
  await mkdir(outDir, { recursive: true });
  const canvas = page.locator('[data-testid="viewport-3d"] canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 120000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('No canvas bounding box');
  const cx = box.x + box.width * 0.55;
  const cy = box.y + box.height * 0.5;
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const dx = Math.cos(angle) * box.width * 0.22;
    const dy = Math.sin(angle) * box.height * 0.18;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await clipScreenshot(page, path.join(outDir, `orbit-${String(i + 1).padStart(2, '0')}.jpg`));
  }
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForTimeout(1200);
  await clipScreenshot(page, path.join(outDir, 'top-down.jpg'));
}

async function main() {
  const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env },
    detached: true,
  });
  try {
    await waitForUrl(BASE);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(seedAllTourSeenKeys);
    const page = await context.newPage();
    await setupPage(page, preset);
    await orbitFrames(page, OUT);
    await context.close();
    await browser.close();
    console.log(`Wrote ${OUT}`);
  } finally {
    try {
      if (preview.pid) process.kill(-preview.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
