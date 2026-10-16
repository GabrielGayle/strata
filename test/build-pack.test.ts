import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS, type Project } from '../src/core/project';
import { buildPackHtml } from '../src/core/buildPack';
import { buildZip } from '../src/core/exporters';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const date = new Date(2026, 9, 15);

function pack(p: Project) {
  const m = createPipeline()(p, assets);
  return { m, html: buildPackHtml(p, m, { date }) };
}
const preset = (name: string) => applyPreset(newProject(), PRESETS.find((x) => x.name === name)!);
const section = (html: string, id: string) => html.includes(`<section id="${id}">`);

describe('build pack', { timeout: 30_000 }, () => {
  it('row design: cover, layout, schedule, assembly, pour plan and parts; no rods or glue-up', () => {
    const p = newProject();
    p.name = 'Wall <piece>';
    const { m, html } = pack(p);
    expect(html).toContain('<h1>Wall &lt;piece&gt;</h1>');
    expect(html).toContain('15 Oct 2026');
    expect(html).toContain('Row: 40 plates');
    expect(html).toContain('Print / Save PDF');
    expect(html).toContain('window.print()');
    expect(html).toContain('@page { size: A4');
    for (const id of ['layout', 'elevations', 'schedule', 'assembly', 'pour', 'parts']) expect(section(html, id)).toBe(true);
    expect(section(html, 'rods')).toBe(false);
    expect(section(html, 'glue')).toBe(false);
    // every plate is named in the layout drawing and in the schedule
    for (const part of m.sliced.parts) expect(html).toContain(`<td class="id">${part.id}</td>`);
    expect(html).toContain('FRONT');
    // back to front: the last plate goes in first
    const ids = m.sliced.parts.filter((q) => q.family === 'P').map((q) => q.id);
    expect(html).toContain(`<b>${ids[ids.length - 1]}</b> first, <b>${ids[0]}</b> last`);
    expect(html).toContain('Bottom band');
  });

  it('angled views: one on the cover, two more on their own page, in the plates\' metal on the concrete', () => {
    const p = newProject();
    p.appearance = { buckets: [{ id: 'b1', name: 'Bright', material: 'aluminium', finish: 'polished' }], assign: { P1: 'b1' } };
    const { html } = pack(p);
    const cover = html.slice(html.indexOf('<section class="cover">'), html.indexOf('<section id="layout">'));
    expect(cover).toContain('class="drawing angled"');
    expect(cover).toContain('From the front right');
    expect(section(html, 'views')).toBe(true);
    const views = html.slice(html.indexOf('<section id="views">'), html.indexOf('<section id="schedule">'));
    expect(views.match(/class="drawing angled"/g)).toHaveLength(2);
    // weathered Corten, polished aluminium and the concrete tint all show up as fills
    const fills = new Set([...html.matchAll(/class="drawing angled"[\s\S]*?<\/svg>/g)].flatMap((m) => [...m[0].matchAll(/fill="(#[0-9a-f]{6})"/g)].map((f) => f[1])));
    const red = [...fills].some((c) => parseInt(c.slice(1, 3), 16) > parseInt(c.slice(5, 7), 16) * 1.6);
    const pale = [...fills].some((c) => parseInt(c.slice(1, 3), 16) > 0xb0 && parseInt(c.slice(5, 7), 16) > 0xb0);
    expect(red).toBe(true);
    expect(pale).toBe(true);
  });

  it('flat stack: glue-up order bottom to top, no rods', () => {
    const { m, html } = pack(preset('Stamped stack'));
    expect(section(html, 'glue')).toBe(true);
    expect(section(html, 'rods')).toBe(false);
    expect(html).toContain('Flat stack: 20 layers');
    expect(html).toContain('Glue the layers up from the bottom');
    const glue = html.slice(html.indexOf('<section id="glue">'));
    const layers = m.sliced.plates.filter((pl) => pl.parts.length);
    const at = layers.map((pl) => glue.indexOf(`<td class="id">L${pl.def.index + 1}</td>`));
    expect(at.every((x) => x > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(glue).toContain('template for the pins');
  });

  it('braced design: rod table, nut positions, spacer lengths and the laser-cut spacers', () => {
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', anchorHoles: '0', plateCount: '12', rodsOn: true, rodCount: '2', rodSize: 'M6', spacerMode: 'both' };
    p.moves = { P3: { t: [0, 0, 12], q: [0, 0, 0, 1] } };
    const { m, html } = pack(p);
    expect(m.sliced.brace?.rods?.rods.length).toBe(2);
    expect(section(html, 'rods')).toBe(true);
    const rods = html.slice(html.indexOf('<section id="rods">'));
    expect(rods).toContain('Rods and spacers');
    expect(rods).toContain('rod holes Ø6.5 mm for M6 rod');
    expect(rods).toContain('Nuts (N) and washers (W) along the rod');
    expect(rods).toContain('Spacer length per gap');
    expect(rods).toContain('Cross piece (cast in)');
    expect(rods).toContain('Spacing template (lift off)');
    expect(html).toContain('Make up the rod cage');
    // the hand move shows in the schedule and the assembly order
    expect(html).toContain('12 mm right');
    expect(html).toContain('Hand-placed plates');
  });

  it('radial design starts at the plate facing the front', () => {
    const { html } = pack(preset('Radial bloom'));
    expect(html).toContain('Radial: 28 plates');
    expect(html).toMatch(/start with <b>SR-15<\/b> at the front/);
    expect(html).not.toContain('Side elevation');
  });

  it('rides along in the ZIP every time', () => {
    const p = newProject();
    const m = createPipeline()(p, assets);
    const files = unzipSync(buildZip(m, p));
    expect(strFromU8(files['build-pack.html'])).toContain('Strata build pack');
  });
});
