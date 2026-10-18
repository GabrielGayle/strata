import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seedAllTourSeenKeys, waitForModelCurrent } from './map-helpers';
import { shadow8Json, vermilion93Json } from '../test/engine-fixtures';

// Plan A acceptance: a 10 s slider drag never blocks the page for more than 50 ms.
//
// Measured from a Chromium trace: each main-thread task, minus the compositor
// "Commit" inside it. Without a GPU (CI and cloud containers) Chromium draws the
// WebGL canvas in software and the commit waits on that for about 1.5 s per frame,
// even with no edits at all; on a machine with a GPU it takes a few milliseconds.
// Everything Strata itself runs on the page (React, three.js, taking results from
// the engine worker) is counted.
const LIMIT_MS = 50;
const DRAG_MS = 10_000;
const OUT = join(process.cwd(), 'test-results/engine-drag');

async function open(page: Page, projectJson: string) {
  await page.addInitScript(seedAllTourSeenKeys);
  await page.addInitScript((project) => {
    localStorage.setItem('strata.project.v1', project);
    localStorage.setItem('strata.ui.v1', JSON.stringify({ tab: '3d', collapsed: {}, ortho: false }));
  }, projectJson);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.waitForSelector('.app.window', { timeout: 60_000 });
  await expect(page.getByTestId('status-counts')).toContainText(/\d+\s+plates/, { timeout: 90_000 });
  await expect(page.getByTestId('viewport-3d').locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // let the first build and the worker's warm-up settle before measuring
  await page.waitForTimeout(6_000);
}

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string };
}

/** Main-thread tasks in a trace, in ms, each without the compositor commit it waited on. */
function pageTasks(events: TraceEvent[]) {
  const mains = new Set(events.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const onMain = events.filter((e) => e.ph === 'X' && mains.has(`${e.pid}:${e.tid}`));
  const commits = onMain.filter((e) => e.name === 'Commit');
  const replies = onMain.filter((e) => e.name === 'HandlePostMessage').length;
  const tasks = onMain
    .filter((e) => e.name === 'RunTask')
    .map((t) => {
      const end = t.ts + t.dur!;
      const commit = commits.filter((c) => c.ts >= t.ts && c.ts + c.dur! <= end).reduce((a, c) => a + c.dur!, 0);
      return { ms: (t.dur! - commit) / 1000, commitMs: commit / 1000 };
    });
  return { tasks, replies };
}

/** Drags a slider back and forth for DRAG_MS under a trace. */
async function drag(browser: Browser, page: Page, label: string, tracePath: string) {
  const slider = page.getByRole('slider', { name: label, exact: true }).first();
  await slider.scrollIntoViewIfNeeded();
  const before = await slider.inputValue();
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.2;
  const x1 = box.x + box.width * 0.6;
  await browser.startTracing(page, { path: tracePath, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < DRAG_MS) {
    const t = (i++ % 40) / 40;
    await page.mouse.move(x0 + (x1 - x0) * (t < 0.5 ? t * 2 : 2 - t * 2), y);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  await browser.stopTracing();
  expect(await slider.inputValue(), 'the drag moved the slider').not.toBe(before);
  return pageTasks(JSON.parse(await readFile(tracePath, 'utf8')).traceEvents as TraceEvent[]);
}

const cases = [
  { name: 'vermilion-93', json: vermilion93Json, plates: 93 },
  { name: 'shadow-8-frames', json: shadow8Json, plates: 40 },
];

for (const c of cases) {
  test(`slider drag keeps the page responsive: ${c.name}`, async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs Chromium tracing');
    test.setTimeout(240_000);
    await mkdir(OUT, { recursive: true });
    await open(page, c.json());
    await expect(page.getByTestId('status-counts')).toContainText(`${c.plates} plates`);
    const { tasks, replies } = await drag(browser, page, 'Erosion amplitude', join(OUT, `${c.name}.trace.json`));
    const worst = tasks.map((t) => t.ms).sort((a, b) => b - a);
    const summary = { case: c.name, worstMs: worst.slice(0, 5).map(Math.round), over50: worst.filter((ms) => ms > LIMIT_MS).length, engineReplies: replies };
    console.log(JSON.stringify(summary));
    await writeFile(join(OUT, `${c.name}.json`), JSON.stringify(summary, null, 2));
    // the full model follows once the slider is let go
    await waitForModelCurrent(page);
    await expect(page.getByTestId('status-counts')).toContainText(`${c.plates} plates`);
    if (process.env.ENGINE_DRAG_BASELINE !== '1') expect(worst[0]).toBeLessThanOrEqual(LIMIT_MS);
  });
}
