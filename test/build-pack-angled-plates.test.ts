import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { angledPlatePathCount, buildPackHtml, paintOrder, type PaintItem, type Vtx } from '../src/core/buildPack';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function paceyRowProject(thickness = '0.5') {
  const p = newProject();
  p.name = 'Pacey row';
  p.params.plateCount = '94';
  p.params.pitch = '2.5';
  p.params.thickness = thickness;
  p.params.baseLength = '514';
  p.params.baseWidth = '394.5';
  p.params.baseHeight = '85';
  p.params.stackHeight = '15';
  p.params.crest = '0';
  p.params.erosionAmp = '0';
  return p;
}

describe('build pack angled plate render', { timeout: 60_000 }, () => {
  it('draws every main plate in the cover angled view (thin 0.5 mm row)', () => {
    const m = createPipeline()(paceyRowProject('0.5'), assets);
    expect(m.sliced.parts.filter((p) => p.family === 'P').length).toBe(94);
    const tight = angledPlatePathCount(paceyRowProject('0.5'), m, { maxH: 120, maxW: 260 });
    const cover = angledPlatePathCount(paceyRowProject('0.5'), m, { maxH: 400 });
    expect(tight.drawn).toBe(tight.expected);
    expect(cover.drawn).toBe(94);
    expect(cover.drawn).toBe(cover.expected);
  });

  it('draws every main plate for a thicker control row', () => {
    const p = paceyRowProject('3');
    p.params.plateCount = '40';
    p.params.pitch = '6';
    const m = createPipeline()(p, assets);
    const { drawn, expected } = angledPlatePathCount(p, m, { maxH: 400 });
    expect(drawn).toBe(expected);
    expect(drawn).toBe(40);
  });

  it('matches DXF part count for the thin row', () => {
    const m = createPipeline()(paceyRowProject('0.5'), assets);
    const html = buildPackHtml(paceyRowProject('0.5'), m);
    const ids = m.sliced.parts.filter((q) => q.family === 'P').map((q) => q.id);
    for (const id of ids) expect(html).toContain(`<td class="id">${id}</td>`);
    expect(angledPlatePathCount(paceyRowProject('0.5'), m).drawn).toBe(ids.length);
  });
});

describe('build pack angled views: crossing parts and dense rows', { timeout: 60_000 }, () => {
  it('paints two crossing plates far half first, near half last', () => {
    // A stands in x = 0 (across z), B in z = 0 (across x); they cross on the y axis
    const sq = (pts: [number, number, number][]): Vtx[][] => [pts.map((p) => ({ p, e: true }))];
    const A: PaintItem = { d: 0, rings: sq([[0, 0, -1], [0, 0, 1], [0, 1, 1], [0, 1, -1]]), fill: '#a00000', stroke: '#000', sw: 1, plate: true, part: 0, plane: 0 };
    const B: PaintItem = { d: 0, rings: sq([[-1, 0, 0], [1, 0, 0], [1, 1, 0], [-1, 1, 0]]), fill: '#00a000', stroke: '#000', sw: 1, plate: true, part: 1, plane: 1 };
    const planes = [{ n: [1, 0, 0] as [number, number, number], d: 0 }, { n: [0, 0, 1] as [number, number, number], d: 0 }];
    const toCam: [number, number, number] = [1, 1, 1];
    const order = paintOrder([A, B], planes, toCam, (w) => -(w[0] + w[1] + w[2]));
    const where = (part: number, test: (p: [number, number, number]) => boolean) => order.findIndex((it) => it.part === part && it.rings[0].every((q) => test(q.p)));
    // B is cut by A's plane into x < 0 (far) and x > 0 (near); A's own plane node sits between them
    const bFar = where(1, (p) => p[0] <= 1e-9), bNear = where(1, (p) => p[0] >= -1e-9);
    const aAll = order.findIndex((it) => it.part === 0);
    expect(bFar).toBeGreaterThanOrEqual(0);
    expect(bNear).toBeGreaterThan(bFar);
    expect(aAll).toBeGreaterThan(bFar);
    expect(aAll).toBeLessThan(bNear);
    // the cut edge is marked, so it is not outlined like the plate's own edges
    expect(order[bFar].rings[0].some((q) => !q.e)).toBe(true);
  });

  it('a waffle draws every plate, splitting the ones that cross', () => {
    const p = applyPreset(newProject(), PRESETS.find((x) => x.name === 'Waffle field')!);
    const m = createPipeline()(p, assets);
    const { drawn, expected } = angledPlatePathCount(p, m);
    expect(drawn).toBe(expected);
    const html = buildPackHtml(p, m);
    const cover = html.slice(html.indexOf('<section class="cover">'), html.indexOf('</section>'));
    expect(cover.match(/class="plate"/g)!.length).toBeGreaterThan(expected);
  });

  it('dense rows: plate names in the plan never print over each other; first and last always named', () => {
    const p = paceyRowProject('0.5');
    const m = createPipeline()(p, assets);
    const html = buildPackHtml(p, m);
    const layout = html.slice(html.indexOf('<section id="layout">'), html.indexOf('<section id="elevations">'));
    const ids = m.sliced.parts.filter((q) => q.family === 'P').sort((a, b) => a.index - b.index).map((q) => q.id);
    const labels = [...layout.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(start|end)" font-size="11" font-weight="600">([^<]+)<\/text>/g)].map((x) => ({ y: +x[2], side: x[3], id: x[4] }));
    expect(labels.length).toBeLessThan(ids.length);
    expect(labels.map((l) => l.id)).toContain(ids[0]);
    expect(labels.map((l) => l.id)).toContain(ids[ids.length - 1]);
    for (const side of ['start', 'end']) {
      const ys = labels.filter((l) => l.side === side).map((l) => l.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12.9);
    }
    expect(layout).toContain(`all ${ids.length} are in the schedule`);
  });
});
