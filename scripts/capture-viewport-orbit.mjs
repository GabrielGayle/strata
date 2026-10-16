/**
 * Orbit the 3D viewport and save PNG frames (no video).
 * Usage: VITE_E2E_MAP_FIXTURES=1 npm run build && node scripts/capture-viewport-orbit.mjs [before|after] [preset]
 * preset: default | map-x18-frame
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
const preset = process.argv[3] ?? 'default';
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

async function dismissTour(page) {
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function waitForViewportCanvas(page) {
  await page.waitForSelector('.ws-area canvas', { timeout: 120000 });
  await page.waitForFunction(() => {
    const c = document.querySelector('.ws-area canvas');
    return !!c && c.clientWidth > 80 && c.clientHeight > 80;
  }, { timeout: 120000 });
  await page.waitForTimeout(800);
}

async function show3dTab(page) {
  const tab3d = page.getByRole('tab', { name: /^3D$/i });
  if (await tab3d.count()) await tab3d.click();
  else await page.keyboard.press('1');
}

async function waitMapReady(page) {
  await page.waitForFunction(
    () => {
      const bar = document.querySelector('.status-bar')?.textContent ?? '';
      const working = document.querySelector('.map-terrain-working');
      if (working) return false;
      return /ready/i.test(bar) || /(\d+)\s+parts/.test(bar);
    },
    { timeout: 240000 },
  );
}

async function setupPage(page, presetId) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('.app.window', { timeout: 120000 });
  await dismissTour(page);
  await expectStatusReady(page);

  if (presetId === 'map-x18-frame') {
    console.log('map: opening Map tab');
    await page.getByRole('button', { name: /Maps/i }).click();
    await page.getByRole('button', { name: /Open Map tab/i }).click();
    await page.waitForSelector('.map-view', { timeout: 60000 });
    console.log('map: Neasden preset');
    await page.locator('.map-view').getByRole('button', { name: 'Neasden', exact: true }).click();
    await waitMapReady(page);
    console.log('map: set ×18 + sunken frame');
    await page.getByLabel('Vertical exaggeration').selectOption('18');
    await page.locator('label').filter({ hasText: 'Sunken concrete frame' }).locator('input[type=checkbox]').check({ force: true });
    await waitMapReady(page);
    console.log('map: back to 3D');
    await show3dTab(page);
    await waitForViewportCanvas(page);
    await expectStatusReady(page, 180000);
    await page.waitForTimeout(2500);
    return;
  }

  await waitForViewportCanvas(page);
  await page.waitForTimeout(1500);
}

async function clipScreenshot(page, filePath) {
  const canvas = page.locator('.ws-area canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 120000 });
  const box = await canvas.boundingBox();
  if (!box || box.width < 40 || box.height < 40) throw new Error('No canvas bounding box');
  // WebGL canvases never go "stable" under rAF; clip the page instead of locator.screenshot().
  await page.screenshot({
    path: filePath,
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
  const canvas = page.locator('.ws-area canvas').first();
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
    await clipScreenshot(page, path.join(outDir, `orbit-${String(i + 1).padStart(2, '0')}.png`));
  }
}

async function main() {
  const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, VITE_E2E_MAP_FIXTURES: '1' },
  });
  preview.unref?.();
  try {
    await waitForUrl(BASE);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(() => {
      localStorage.setItem('strata:tour-seen', '1');
    });
    const page = await context.newPage();
    await setupPage(page, preset);
    await orbitFrames(page, OUT);
    await context.close();
    await browser.close();
    console.log(`Wrote ${OUT}`);
  } finally {
    try {
      preview.kill('SIGKILL');
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
