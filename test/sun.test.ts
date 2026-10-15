import { describe, expect, it } from 'vitest';
import { bearingToWorld, clock, dayOfYear, sunPosition, sunTimes, sunVector, type Site } from '../src/core/sun';
import { defaultRaw, evaluateParams } from '../src/core/params';

const london = (month: number, day: number, utc = 0): Site => ({ lat: 51.5074, lon: -0.1278, utc, month, day });

describe('sun position', () => {
  it('counts days of the year', () => {
    expect(dayOfYear(1, 1)).toBe(1);
    expect(dayOfYear(3, 1)).toBe(60);
    expect(dayOfYear(12, 31)).toBe(365);
    expect(dayOfYear(2, 31)).toBe(59); // clamped to 28 Feb
  });

  it('puts the London midsummer noon sun high in the south', () => {
    const p = sunPosition(london(6, 21), sunTimes(london(6, 21)).noon);
    expect(p.elevation).toBeGreaterThan(61.5);
    expect(p.elevation).toBeLessThan(62.5);
    expect(Math.abs(p.azimuth - 180)).toBeLessThan(0.5);
  });

  it('puts the midwinter noon sun low', () => {
    const p = sunPosition(london(12, 21), 12);
    expect(p.elevation).toBeGreaterThan(14.5);
    expect(p.elevation).toBeLessThan(15.5);
  });

  it('rises in the east and sets in the west', () => {
    expect(sunPosition(london(3, 20), 9).azimuth).toBeLessThan(180);
    expect(sunPosition(london(3, 20), 15).azimuth).toBeGreaterThan(180);
    expect(sunPosition(london(3, 20), 0).elevation).toBeLessThan(0);
  });

  it('matches published London sunrise and sunset (21 June, BST)', () => {
    // timeanddate.com: sunrise 04:43, sunset 21:21 BST
    const t = sunTimes(london(6, 21, 1));
    expect(Math.abs(t.rise! - (4 + 43 / 60))).toBeLessThan(4 / 60);
    expect(Math.abs(t.set! - (21 + 21 / 60))).toBeLessThan(4 / 60);
    expect(clock(t.noon)).toMatch(/^13:0[0-3]$/);
  });

  it('has no sunrise in polar night', () => {
    const t = sunTimes({ lat: 78, lon: 15, utc: 1, month: 12, day: 21 });
    expect(t.rise).toBeNull();
  });
});

describe('compass on the design', () => {
  const v = evaluateParams({ ...defaultRaw(), sunFacing: '180' }).values;
  it('maps the facing bearing onto the front end', () => {
    // stack runs along +x, so the front looks out along -x
    const [x, z] = bearingToWorld(v, 180);
    expect(x).toBeCloseTo(-1);
    expect(z).toBeCloseTo(0);
  });
  it('turns clockwise seen from above', () => {
    // facing south: west is 90° clockwise from south
    const [x, z] = bearingToWorld(v, 270);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });
  it('points the sun vector up when the sun is up', () => {
    const s = sunVector(v, { elevation: 30, azimuth: 180 });
    expect(s[1]).toBeCloseTo(0.5);
    expect(Math.hypot(...s)).toBeCloseTo(1);
  });
});
