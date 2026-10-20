import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, serialize, type Project } from '../src/core/project';
import { proposalViews } from '../src/core/buildPack';
import { cleanProposal, defaultProposal, proposalDefaults, proposalHtml } from '../src/core/proposal';
import { defaultMapSpec } from '../src/core/mapSpec';
import { decodeShare, encodeShare, projectFromShare, shareState } from '../src/core/share';
import { resultKey } from '../src/core/resultCache';
import { smallProject } from './small-project';

const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const date = new Date('2026-10-20T12:00:00Z');

function withProposal(p: Project, patch: Partial<ReturnType<typeof defaultProposal>>): Project {
  return { ...p, proposal: { ...defaultProposal(), ...patch } };
}

describe('client proposal page', { timeout: 60_000 }, () => {
  const base = smallProject();
  const m = createPipeline()(base, none);

  it('leads with the place and quotation, then the piece, then terms, with the spec folded last', () => {
    const html = proposalHtml(withProposal(base, { place: 'Buttermere', quote: 'The lake was still as glass.', quoteBy: 'A. Wainwright' }), m, undefined, { date });
    const at = (s: string) => html.indexOf(`data-section="${s}"`);
    expect(at('place')).toBeGreaterThan(0);
    expect(at('place')).toBeLessThan(at('render'));
    expect(at('render')).toBeLessThan(at('terms'));
    expect(at('terms')).toBeLessThan(at('spec'));
    expect(html).toMatch(/<details class="spec"[^>]*>\s*<summary>Technical sheet<\/summary>/);
    expect(html).toContain('<h1>Buttermere</h1>');
    expect(html).toContain('The lake was still as glass.');
    expect(html).toContain('20 October 2026');
    // the public look, not the studio skin
    expect(html).not.toMatch(/98\.css|win98/i);
  });

  it('prints undecided fields as [… to confirm] and marks an unquoted price est.', () => {
    const empty = proposalHtml(withProposal(base, {}), m, undefined, { date });
    for (const what of ['price', 'timeline', 'finish', 'upkeep', 'local quotation', 'client', 'number']) expect(empty).toContain(`[${what} to confirm]`);
    const priced = proposalHtml(withProposal(base, { price: '£4,200–4,800', priceEst: true }), m, undefined, { date });
    expect(priced).toContain('£4,200–4,800 <span class="est">est.</span>');
    const quoted = proposalHtml(withProposal(base, { price: '£4,800', priceEst: false }), m, undefined, { date });
    expect(quoted).toContain('£4,800');
    expect(quoted).not.toContain('class="est"');
  });

  it('escapes what was typed', () => {
    const html = proposalHtml(withProposal(base, { client: '<script>alert(1)</script>' }), m, undefined, { date });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  it('draws plan, front and side at one scale', () => {
    const v = proposalViews(base, m);
    // front, side and plan nested in one drawing so they scale together
    expect(v.ortho.match(/<svg/g)).toHaveLength(4);
    for (const k of ['Front', 'Side', 'Plan']) expect(v.ortho).toContain(`>${k}</text>`);
    expect(v.scale).toBeGreaterThan(0);
    expect(v.plates).toBe(m.sliced.plates.length);
  });

  it('keeps the proposal in project files and share links, without changing the built model', () => {
    const p = withProposal(base, { place: 'Grasmere', price: '£850–1,100' });
    const back = deserialize(serialize(p));
    expect(back.proposal).toEqual(p.proposal);
    expect(projectFromShare(shareState(p)).proposal).toEqual(p.proposal);
    expect(resultKey(p, none)).toBe(resultKey(base, none));
  });

  it('round-trips through an encoded link', async () => {
    const p = withProposal(base, { place: 'Woolwich', quote: 'A line\n\nand another' });
    const s = await decodeShare(await encodeShare(shareState(p), { compress: false }));
    expect(projectFromShare(s).proposal?.quote).toBe('A line\n\nand another');
  });

  it('names the elevation data a map was really built from', () => {
    const withMap = (patch: Parameters<typeof defaultMapSpec>[0]): Project => ({ ...base, images: { top: { map: defaultMapSpec(patch) } as Project['images']['top'] } });
    const bbox: [number, number, number, number] = [-3.3, 54.5, -3.2, 54.6];
    // asked for EA, fell back to Terrarium: the licence lines tell
    expect(proposalDefaults(withMap({ bbox, source: 'ea-dtm', title: 'Buttermere', attribution: ['Terrain tiles © Mapzen'] })).archetype).toBe('Mapzen Terrarium elevation tiles, Buttermere');
    expect(proposalDefaults(withMap({ bbox, source: 'auto', attribution: ['© Environment Agency copyright and/or database right 2026'] })).archetype).toBe('Environment Agency LiDAR, 1 m terrain model');
    expect(proposalDefaults(withMap({ bbox, source: 'auto', title: 'Grasmere', attribution: [] })).place).toBe('Grasmere');
  });

  it('cleans a proposal read back from a file', () => {
    expect(cleanProposal(null)).toBeUndefined();
    const c = cleanProposal({ place: 'Helvellyn', price: 42, priceEst: 'yes', extra: 'x' })!;
    expect(c.place).toBe('Helvellyn');
    expect(c.price).toBe('');
    expect(c.priceEst).toBe(true);
    expect('extra' in c).toBe(false);
  });
});
