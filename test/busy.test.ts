import { describe, expect, it } from 'vitest';
import { beginBusy, busyElapsed, busyFraction, busyRemaining, busyThen, depthStep, trackBusy, useBusy } from '../src/ui/busy';
import { ICONS, PAL } from '../src/ui/BusyAnim';
import { depthWaitEstimate } from '../src/core/depth';

const tasks = () => useBusy.getState().tasks;

describe('busy list', () => {
  it('begin, update and end a wait', () => {
    const h = beginBusy({ scene: 'export', title: 'Exporting' });
    expect(tasks().find((t) => t.id === h.id)).toMatchObject({ title: 'Exporting', window: true });
    h.update({ detail: 'Nesting…', done: 2, total: 5 });
    expect(tasks().find((t) => t.id === h.id)).toMatchObject({ detail: 'Nesting…', done: 2, total: 5 });
    h.end();
    h.end();
    h.update({ detail: 'late' });
    expect(tasks().some((t) => t.id === h.id)).toBe(false);
  });

  it('trackBusy ends the wait even when the work fails', async () => {
    await expect(trackBusy({ scene: 'search', title: 'Finding' }, Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(tasks()).toHaveLength(0);
    await expect(trackBusy({ scene: 'save', title: 'Projects' }, async (h) => (h.update({ detail: 'x' }), 7))).resolves.toBe(7);
    expect(tasks()).toHaveLength(0);
  });

  it('busyThen shows its window straight away, then runs blocking work', async () => {
    let seen: unknown;
    const out = await busyThen({ scene: 'pack', title: 'Build pack' }, () => {
      seen = tasks()[0];
      return 'done';
    });
    expect(out).toBe('done');
    expect(seen).toMatchObject({ title: 'Build pack', delayMs: 0 });
    expect(tasks()).toHaveLength(0);
  });
});

describe('progress readouts', () => {
  it('known counts give an exact fraction', () => {
    expect(busyFraction({ done: 3, total: 4, startedAt: 0 })).toBe(0.75);
  });
  it('no counts and no estimate means a sliding bar', () => {
    expect(busyFraction({ startedAt: 0 })).toBeNull();
    expect(busyRemaining({ startedAt: 0 })).toBeNull();
  });
  it('a timed bar keeps moving but never reaches the end on its own', () => {
    const t = { expectMs: 10_000, startedAt: 0 };
    const at = (ms: number) => busyFraction(t, ms)!;
    expect(at(5_000)).toBeCloseTo(0.45);
    expect(at(10_000)).toBeCloseTo(0.9);
    expect(at(60_000)).toBeLessThanOrEqual(0.95);
    expect(at(60_000)).toBeGreaterThan(at(20_000));
  });
  it('time left reads like a person would say it', () => {
    const t = { expectMs: 53_000, startedAt: 0 };
    expect(busyRemaining(t, 0)).toBe('about 55 s left');
    expect(busyRemaining(t, 41_000)).toBe('about 12 s left');
    expect(busyRemaining(t, 52_000)).toBe('a few more seconds');
    expect(busyElapsed({ startedAt: 0 }, 75_000)).toBe('1 min 15 s');
  });
});

describe('depth from photo wait', () => {
  it('a cold server is expected to take its boot time plus the read', () => {
    const est = depthWaitEstimate(Date.now());
    expect(est.bootMs).toBe(45_000);
    expect(est.totalMs).toBeGreaterThan(est.bootMs);
  });
  it('says what is happening at each stage', () => {
    const est = { bootMs: 45_000, totalMs: 53_000 };
    expect(depthStep(500, est)).toMatch(/Sending/);
    expect(depthStep(10_000, est)).toMatch(/Waking/);
    expect(depthStep(50_000, est)).toMatch(/Reading depth/);
    expect(depthStep(90_000, est)).toMatch(/longer than usual/);
    expect(depthStep(3_000, { bootMs: 0, totalMs: 8_000 })).toMatch(/Reading depth/);
  });
});

describe('pixel icons', () => {
  it('every icon is a full rectangle drawn only in palette colours', () => {
    for (const [name, rows] of Object.entries(ICONS)) {
      const w = rows[0].length;
      expect([8, 16], name).toContain(w);
      expect(rows.length, name).toBe(w);
      for (const row of rows) {
        expect(row.length, `${name}: ${row}`).toBe(w);
        for (const ch of row) expect(ch === '.' || ch in PAL, `${name} uses "${ch}"`).toBe(true);
      }
    }
  });
});
