// Lace plates: a stack drawn in lace (.lace-loft.json) used as the plates, as drawn.
import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, serialize } from '../src/core/project';
import { laceLink, laceOutline, readLaceLoft, type LaceLoft } from '../src/core/lace';
import { pointInShape, shapeArea, shapeBBox } from '../src/core/geom2d';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Three plates 80 wide, 60, 70, 80 tall, each with a 20 mm square window (a CW hole). */
const loft: LaceLoft = readLaceLoft({
  format: 'lace-loft',
  version: 1,
  name: 'test',
  thickness: 1.5,
  link: 'https://lace.cockpit.yoga/#lace=zabc',
  plates: [60, 70, 80].map((h, i) => ({ name: `p${i}`, layer: `l${i}`, contours: [sq(100, 10, 180, 10 + h), sq(130, 30, 150, 50).reverse()] })),
})!;

describe('reading a lace loft', () => {
  it('takes lace’s file and refuses others', () => {
    expect(loft.plates.length).toBe(3);
    expect(readLaceLoft({ format: 'strata-project' })).toBeNull();
    expect(() => readLaceLoft({ format: 'lace-loft', version: 2, plates: [] })).toThrow(/newer/);
    // a link anywhere but lace is dropped
    expect(readLaceLoft({ ...loft, link: 'https://evil.example/#lace=z' })!.link).toBe('');
  });

  it('opens a plate in lace on its own layer', () => {
    expect(laceLink(loft, 1)).toBe('https://lace.cockpit.yoga/#lace=zabc&layer=l1');
  });

  it('keeps the drawing: centred across, foot on the concrete line, hole kept', () => {
    const s = laceOutline(loft, 2, { flat: false, embed: 0, inset: 0 });
    const b = shapeBBox(s);
    expect(b.minX).toBeCloseTo(-40, 6);
    expect(b.maxX).toBeCloseTo(40, 6);
    expect(b.minY).toBeCloseTo(0, 6);
    expect(b.maxY).toBeCloseTo(80, 6);
    expect(shapeArea(s)).toBeCloseTo(80 * 80 - 400, 3);
    expect(pointInShape([0, 30], s)).toBe(false);
  });
});

describe('lace plates in the slicer', () => {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', sliceMode: 'parallel', baseOn: false, stackSource: 'lace', plateCount: '3', thickness: '1.5' };
  p.lace = loft;

  it('cuts plate i from lace plate i', () => {
    const m = createPipeline()(p, assets);
    const heights = m.sliced.plates.map((pl) => Math.round(Math.max(...pl.parts.map((q) => q.bbox.maxY))));
    expect(heights).toEqual([60, 70, 80]);
    // the window is still cut through each one
    for (const pl of m.sliced.plates) expect(pl.parts.reduce((a, q) => a + q.area, 0)).toBeLessThan(80 * 80);
  });

  it('survives save and open', () => {
    expect(deserialize(serialize(p)).lace?.plates.length).toBe(3);
  });

  it('says when there is no lace stack', () => {
    const q = { ...p, lace: undefined };
    const m = createPipeline()(q, assets);
    expect(m.sliced.warnings.join(' ')).toMatch(/no lace stack/);
  });
});
