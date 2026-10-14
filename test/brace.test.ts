import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { snapRodLength, parseStock, avoid } from '../src/core/brace';
import { hardwareCsv } from '../src/core/bom';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

function run(params: Record<string, string | boolean>) {
  const p = newProject();
  p.params = { ...p.params, ...params };
  return createPipeline()(p, assets);
}

const holesOf = (m: ReturnType<typeof run>) => m.sliced.parts.filter((p) => p.family === 'P').map((p) => p.shape[0].holes.length);
const errors = (m: ReturnType<typeof run>) => m.issues.filter((i) => i.severity === 'error').map((i) => i.message);

describe('rod length snapping', () => {
  const stock = parseStock('100, 150, 200, 250, 300, 400, 500, 1000');
  it('picks the shortest stock that spans the stack and stays in the concrete', () => {
    expect(snapRodLength(180, 400, stock)).toEqual({ length: 200, stock: 200, cut: false });
    expect(snapRodLength(300, 300, stock)).toEqual({ length: 300, stock: 300, cut: false });
  });
  it('cuts a rod down when the next stock would poke out', () => {
    const r = snapRodLength(420, 480, stock);
    expect(r.cut).toBe(true);
    expect(r.length).toBe(480);
    expect(r.stock).toBe(500);
  });
  it('flags rods that cannot fit', () => {
    expect(snapRodLength(500, 300, stock).problem).toBeTruthy();
    expect(snapRodLength(1200, 2000, stock).problem).toContain('longest stock');
  });
  it('parses stock lists loosely', () => {
    expect(parseStock('300; 100 ,200 x 100')).toEqual([100, 200, 300]);
  });
  it('moves positions off blocked ones', () => {
    expect(avoid([0, 50], [1], 5, -100, 100)).toEqual([-4, 50]);
  });
});

describe('threaded rods', () => {
  it('drills every plate tab and lists the hardware', () => {
    const plain = run({ insShape: 'none', anchorHoles: '0' });
    const m = run({ insShape: 'none', anchorHoles: '0', rodsOn: true, rodCount: '2', rodSize: 'M5' });
    const rods = m.sliced.brace!.rods!;
    expect(rods.rods).toHaveLength(2);
    expect(rods.hole).toBeCloseTo(5.5, 5);
    // two more holes in every plate
    expect(holesOf(m).map((h, i) => h - holesOf(plain)[i])).toEqual(holesOf(m).map(() => 2));
    // rods stay inside the concrete
    expect(rods.length.length).toBeLessThanOrEqual(rods.maxLength + 1e-6);
    expect(rods.length.length).toBeGreaterThanOrEqual(rods.minLength - 1e-6);
    // clamp nuts outside the outer plates + an anchor nut at each tip
    expect(rods.nutsPerRod).toBe(4);
    expect(rods.washersPerRod).toBe(2);
    const hw = m.bom.hardware;
    expect(hw.find((r) => r.item === 'Threaded rod')!.qty).toBe(2);
    expect(hw.find((r) => r.item === 'Hex nut')!.qty).toBe(8);
    expect(hardwareCsv(m.bom)).toContain('Hex nut,M5 ISO 4032,8');
    expect(errors(m)).toEqual([]);
  });

  it('locks every plate when asked, and checks the nuts fit between plates', () => {
    const m = run({ insShape: 'none', rodsOn: true, nutPattern: 'every' });
    const n = m.sliced.plates.length;
    expect(m.sliced.brace!.rods!.nutsPerRod).toBe(2 * n + 2);
    expect(errors(m)).toEqual([]);
    const tight = run({ insShape: 'none', rodsOn: true, nutPattern: 'every', rodSize: 'M12' });
    expect(errors(tight).some((e) => e.includes('between plates'))).toBe(true);
  });

  it('snaps to a stock length on a short stack', () => {
    const m = run({ insShape: 'none', rodsOn: true, plateCount: '10', pitch: '20' });
    const L = m.sliced.brace!.rods!.length;
    expect(L.cut).toBe(false);
    expect(L.length).toBe(250);
  });

  it('warns when the rods break out of a shallow tab', () => {
    const m = run({ insShape: 'none', rodsOn: true, rodDepth: '38' });
    expect(errors(m).some((e) => e.includes('break out'))).toBe(true);
  });

  it('drops anchor holes that would run into a rod', () => {
    const m = run({ insShape: 'none', rodsOn: true, rodCount: '2', anchorHoles: '2', rodDepth: '20' });
    const kept = run({ insShape: 'none', rodsOn: true, rodCount: '2', anchorHoles: '3', rodDepth: '20' });
    // three anchor holes at the quarters miss rods at the thirds
    expect(holesOf(kept)[0]).toBe(holesOf(run({ insShape: 'none', anchorHoles: '3' }))[0] + 2);
    // anchor holes sit at the same thirds as the rods, so only the rod holes are left
    const plain = run({ insShape: 'none', anchorHoles: '0' });
    expect(holesOf(m).map((h, i) => h - holesOf(plain)[i])).toEqual(holesOf(m).map(() => 2));
  });

  it('stays out of radial stacks', () => {
    const m = run({ insShape: 'none', sliceMode: 'radial', rodsOn: true });
    expect(m.sliced.brace?.rods ?? null).toBeNull();
  });
});

describe('laser-cut spacers', () => {
  it('cuts cross pieces that hold every plate', () => {
    const m = run({ insShape: 'none', spacerMode: 'cross' });
    const cross = m.sliced.parts.filter((p) => p.family === 'C');
    expect(cross).toHaveLength(2);
    const holds = m.sliced.brace!.spacers!.holds;
    for (const c of cross) expect(holds[c.plateKey]).toHaveLength(m.sliced.plates.length);
    // fully cast in: below the concrete surface
    for (const c of cross) expect(c.bbox.maxY).toBeLessThan(0);
    // ordinary parts: nested and labelled
    expect(m.nested.unplaced).toEqual([]);
    expect(cross[0].id).toBe('SC-01');
    expect(errors(m)).toEqual([]);
  });

  it('cuts a spacing template against the top profile', () => {
    const m = run({ insShape: 'none', spacerMode: 'template' });
    const t = m.sliced.parts.filter((p) => p.family === 'T');
    expect(t).toHaveLength(2);
    const holds = m.sliced.brace!.spacers!.holds;
    for (const p of t) expect(holds[p.plateKey].length).toBe(m.sliced.plates.length);
    // it sits above the concrete so it can lift off
    for (const p of t) expect(p.bbox.minY).toBeGreaterThanOrEqual(m.v.templateLift - 1e-6);
    expect(errors(m)).toEqual([]);
  });

  it('threads rods through angled cross pieces', () => {
    const params = { insShape: 'none', spacerMode: 'cross', crossAngle: '30', crossEngage: '20', embedDepth: '60', rodDepth: '45' };
    const m = run({ ...params, rodsOn: true });
    const bare = run(params);
    const cross = m.sliced.parts.filter((p) => p.family === 'C');
    expect(cross.length).toBe(2);
    // each angled comb is notched where a rod drops through it
    cross.forEach((c, i) => expect(c.area).toBeLessThan(bare.sliced.parts.filter((p) => p.family === 'C')[i].area - 50));
    expect(errors(m)).toEqual([]);
  });

  it('keeps spacers clear of a central fin', () => {
    const m = run({ spacerMode: 'both' });
    expect(m.sliced.parts.filter((p) => p.family === 'C' || p.family === 'T').length).toBe(4);
    expect(errors(m)).toEqual([]);
  });
});

describe('other stacks', () => {
  it('leaves flat stacks alone', () => {
    const m = run({ insShape: 'none', sliceMode: 'flat', rodsOn: true, spacerMode: 'both' });
    expect(m.sliced.brace?.rods ?? null).toBeNull();
    expect(m.sliced.parts.filter((p) => p.family === 'C' || p.family === 'T')).toEqual([]);
  });
});
