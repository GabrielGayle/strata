import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { angledPlatePathCount, buildPackHtml } from '../src/core/buildPack';

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
