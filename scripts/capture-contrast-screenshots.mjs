/**
 * Contrast proof screenshots (Playwright + vite preview).
 * Usage: npm run build && npm run screenshots:contrast
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs/screenshots/contrast');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}/`;

const INK_THEME = { id: 'ink', name: 'Ink', mode: 'dark', hue: 45, sat: 0.06, accent: '#ff6a2e' };

const THEMES = [
  { id: 'light', colorScheme: 'light', theme: { id: 'system' } },
  { id: 'dark', colorScheme: 'dark', theme: { id: 'system' } },
  { id: 'ink', colorScheme: 'dark', theme: INK_THEME },
];

function waitForUrl(url, ms = 90000) {
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

async function captureTheme(browser, theme) {
  const context = await browser.newContext({
    colorScheme: theme.colorScheme,
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript((stored) => {
    localStorage.setItem('strata.theme.v1', JSON.stringify(stored));
    localStorage.setItem('strata:tour-seen', '1');
  }, theme.theme);

  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('.app.window', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.prow').length > 0, { timeout: 120000 });

  const dir = path.join(OUT, theme.id);
  await mkdir(dir, { recursive: true });

  await page.keyboard.press('/');
  await page.waitForSelector('.design-box .design-input', { timeout: 15000 });
  await page.locator('.design-box').screenshot({ path: path.join(dir, 'design-panel.png') });
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: /^Map$/i }).click();
  await page.waitForSelector('.map-view', { timeout: 60000 });
  await page.locator('.map-view').screenshot({ path: path.join(dir, 'map-tab.png') });

  await page.getByRole('tab', { name: /Image/i }).click();
  await page.waitForTimeout(800);
  const imagePanel = page.locator('.main .view, .main .scroll').first();
  await imagePanel.waitFor({ state: 'visible', timeout: 30000 });
  await imagePanel.screenshot({ path: path.join(dir, 'image-fields.png') });

  await page.getByRole('tab', { name: /Compare/i }).click();
  await page.waitForSelector('select.sel', { timeout: 30000 });
  await page.locator('select.sel').first().screenshot({ path: path.join(dir, 'select-dropdown.png') });

  const chop = page.locator('fieldset.section').filter({ hasText: 'Chop Chop price' });
  const head = chop.locator('.section-head');
  if (await head.getByText('Hide').isVisible().catch(() => false)) await head.click();
  await chop.screenshot({ path: path.join(dir, 'chop-chop-collapsed.png') });

  await context.close();
}

async function main() {
  const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let previewLog = '';
  preview.stdout?.on('data', (d) => {
    previewLog += d;
  });
  preview.stderr?.on('data', (d) => {
    previewLog += d;
  });
  try {
    await waitForUrl(BASE);
    const browser = await chromium.launch();
    for (const t of THEMES) {
      console.log(`Capturing theme: ${t.id}`);
      await captureTheme(browser, t);
    }
    await browser.close();
    console.log(`Wrote screenshots under ${OUT}`);
  } catch (e) {
    console.error(previewLog);
    throw e;
  } finally {
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
