/**
 * Orbit the 3D viewport and save frame sequence (+ optional webm via Playwright video).
 * Usage: npm run build && node scripts/capture-viewport-orbit.mjs [before|after] [preset]
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

async function expectStatusReady(page) {
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.status-bar')?.textContent ?? '';
      return /ready/i.test(t) || /(\d+)\s+parts/.test(t);
    },
    { timeout: 240000 },
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

async function setupPage(page, presetId) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('.app.window', { timeout: 120000 });
  await page.evaluate(() => {
    localStorage.setItem('strata:tour-seen', '1');
    localStorage.setItem('strata.tour.v1', '1');
  });
  if (await page.locator('.tour').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Skip' }).click();
  }

  if (presetId === 'map-x18-frame') {
    await page.keyboard.press('/');
    await page.waitForSelector('.design-box .design-input', { timeout: 30000 });
    await page.fill('.design-box .design-input', 'neasden map');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForFunction(
      () => /Fetching|building/i.test(document.querySelector('.status-bar')?.textContent ?? ''),
      { timeout: 30_000 },
    ).catch(() => {});
    await page.waitForFunction(
      () => /ready/i.test(document.querySelector('.status-bar')?.textContent ?? ''),
      { timeout: 180_000 },
    );
    const mapTab = page.getByRole('tab', { name: /^Map$/i });
    if (await mapTab.count()) await mapTab.click();
    else {
      await page.getByRole('button', { name: /Maps/i }).click();
      await page.getByRole('button', { name: /Open Map tab/i }).click();
    }
    await page.waitForSelector('.map-view', { timeout: 60000 });
    await page.getByRole('button', { name: 'Neasden', exact: true }).click();
    await page.waitForTimeout(2000);
    await page.locator('.map-section').filter({ hasText: 'Vertical exaggeration' }).locator('select').selectOption('18');
    await page.locator('label').filter({ hasText: 'Sunken concrete frame' }).locator('input[type=checkbox]').check({ force: true });
    await page.getByRole('button', { name: /Apply bbox/i }).click();
    await page.waitForTimeout(6000);
  }

  await page.waitForSelector('.ws-area canvas', { timeout: 120000 });
  await page.waitForTimeout(2000);
}

async function orbitFrames(page, outDir) {
  await mkdir(outDir, { recursive: true });
  const canvas = page.locator('.ws-area canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForTimeout(500);
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
    await page.waitForTimeout(350);
    await canvas.screenshot({ path: path.join(outDir, `orbit-${String(i + 1).padStart(2, '0')}.png`) });
  }
}

async function main() {
  const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_E2E_MAP_FIXTURES: '1' },
  });
  try {
    await waitForUrl(BASE);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: path.join(OUT, '_video'), size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('strata:tour-seen', '1');
      localStorage.setItem('strata:tour-seen', '1');
    });
    await setupPage(page, preset);
    await orbitFrames(page, OUT);
    await context.close();
    await browser.close();
    console.log(`Wrote ${OUT}`);
  } finally {
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
