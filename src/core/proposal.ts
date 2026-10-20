// The client proposal: one page to send someone who might commission a piece.
// It sells the place first (its name and a real local quotation), then shows
// the piece (a render and plan, front and side drawn at one scale), then the
// price band, the timeline and the finish and its upkeep. The full spec sits in
// a folded technical sheet at the end. It is in the public ECTYPE look, not the
// studio's Win98 skin. Anything not yet decided prints as a bracketed
// "[… to confirm]", and a price not backed by a quote is marked est.
import type { Model } from './pipeline';
import type { Project } from './project';
import type { MapSource } from './mapSpec';
import { proposalViews } from './buildPack';
import { currentHero } from './hero';
import { defaultProposal, type ProposalSpec } from './proposalSpec';

export { cleanProposal, defaultProposal, DEFAULT_CONTACT, type ProposalSpec } from './proposalSpec';

const SOURCE_NAMES: Partial<Record<MapSource, string>> = {
  'ea-dtm': 'Environment Agency LiDAR, 1 m terrain model',
  'ea-dsm': 'Environment Agency LiDAR, 1 m surface model',
  'scot-dtm': 'Scottish Government LiDAR terrain model',
  'wales-dtm': 'Welsh Government LiDAR terrain model',
  'ni-dtm': 'Northern Ireland terrain model',
  terrarium: 'Mapzen Terrarium elevation tiles',
};

/** The elevation data a map was really built from: its licence lines first (a fallback source changes them), else the source it resolved to. */
function sourceName(attribution: string[], source: MapSource): string | undefined {
  const text = attribution.join(' ');
  if (/Environment Agency/i.test(text)) return /surface/i.test(text) || source === 'ea-dsm' ? SOURCE_NAMES['ea-dsm'] : SOURCE_NAMES['ea-dtm'];
  if (/Scottish/i.test(text)) return SOURCE_NAMES['scot-dtm'];
  if (/Welsh|Wales|Cymru/i.test(text)) return SOURCE_NAMES['wales-dtm'];
  if (/Northern Ireland/i.test(text)) return SOURCE_NAMES['ni-dtm'];
  if (/Mapzen|Terrarium/i.test(text)) return SOURCE_NAMES.terrarium;
  return attribution.length ? undefined : SOURCE_NAMES[source];
}

/** What the page prints where a field is empty, before it falls back to "[… to confirm]". */
export function proposalDefaults(project: Project): { place: string; archetype: string; number: string } {
  const map = project.images.top?.map;
  const src = map ? sourceName(map.attribution, map.resolvedSource ?? map.source) : undefined;
  return {
    place: map?.title?.trim() || project.name.trim(),
    archetype: src ? `${src}${map?.title ? `, ${map.title}` : ''}` : '',
    number: map?.editionNumber ? String(map.editionNumber).padStart(3, '0') : '',
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Typed text as HTML: escaped, blank lines become paragraphs. */
const paras = (s: string) =>
  s
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
const tbc = (what: string) => `<span class="tbc">[${esc(what)} to confirm]</span>`;
const or = (s: string, what: string) => (s.trim() ? esc(s.trim()) : tbc(what));
const n0 = (x: number) => String(Math.round(x));

export interface ProposalOptions {
  /** Printed under the heading; today when left out. */
  date?: Date;
}

export function proposalHtml(project: Project, m: Model, spec: ProposalSpec = project.proposal ?? defaultProposal(), opts: ProposalOptions = {}): string {
  const d = proposalDefaults(project);
  const views = proposalViews(project, m);
  const hero = currentHero(project, m);
  const map = project.images.top?.map;
  const date = (opts.date ?? new Date()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const place = spec.place.trim() || d.place;
  const number = spec.number.trim() || d.number;
  const archetype = spec.archetype.trim() || d.archetype;
  const name = place || project.name || 'Untitled';
  const v = m.v;

  const price = spec.price.trim() ? `${esc(spec.price.trim())}${spec.priceEst ? ' <span class="est">est.</span>' : ''}` : tbc('price');
  const spec_: [string, string][] = [
    ['Overall size', `${n0(views.size.w)} × ${n0(views.size.d)} × ${n0(views.size.h)} mm (wide × deep × high)`],
    ['Construction', esc(views.mode)],
    ['Plates', `${views.plates} plates, ${views.parts} laser-cut parts, ${v.thickness} mm sheet`],
    ['Material', views.finishes.length ? esc(views.finishes.join('; ')) : 'No sheet metal'],
    ['Weight', `about ${n0(views.weight)} kg`],
  ];
  if (v.baseOn) spec_.push(['Base', `cast base, ${n0(v.baseHeight)} mm deep`]);
  if (map) {
    const [w, s, e, n] = map.bbox;
    spec_.push(['Area', `${s.toFixed(4)}° N to ${n.toFixed(4)}° N, ${w.toFixed(4)}° to ${e.toFixed(4)}° E`]);
    if (map.exaggerationReadout) spec_.push(['Relief', `heights exaggerated ${esc(map.exaggerationReadout)}`]);
    if (map.attribution.length) spec_.push(['Map data', map.attribution.map(esc).join('<br>')]);
  }

  const picture = hero
    ? `<img src="${hero.png}" width="${hero.w}" height="${hero.h}" alt="${esc(name)}, rendered">`
    : views.angled;
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`ECTYPE — ${name}`)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500&display=swap">
<style>
  :root {
    --paper: #f4f2ec; --ink: #1d1e20; --steel: #6e7276; --scale: #2b2c2e; --concrete: #c9c5bc; --rule: #c9c5bc; --vermilion: #d9381e;
    --serif: 'Cormorant Garamond', 'Iowan Old Style', Georgia, serif; --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace; --sans: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  html { background: var(--paper); }
  body { margin: 0 auto; max-width: 860px; padding: 0 24px 64px; background: var(--paper); color: var(--ink); font: 16px/1.6 var(--sans); }
  hr, section + section { border: 0; border-top: 1px solid var(--rule); }
  header.mast { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 32px 0 18px; border-bottom: 1px solid var(--ink); flex-wrap: wrap; }
  .wordmark { font: 600 22px/1 var(--serif); letter-spacing: .32em; position: relative; text-shadow: 1.5px 1.5px 0 var(--concrete), 3px 3px 0 color-mix(in srgb, var(--concrete) 50%, transparent); }
  .meta { font: 12px/1.5 var(--mono); color: var(--steel); text-align: right; }
  section { padding: 40px 0; }
  .place h1 { font: 500 clamp(44px, 9vw, 88px)/1 var(--serif); margin: 0 0 32px; letter-spacing: -.01em; }
  blockquote { margin: 0; max-width: 34em; }
  blockquote p { font: italic 500 clamp(22px, 3.4vw, 30px)/1.35 var(--serif); margin: 0 0 12px; }
  blockquote footer { font-size: 14px; color: var(--steel); }
  blockquote footer::before { content: '— '; }
  .archetype { font: 13px/1.5 var(--mono); margin: 28px 0 0; color: var(--steel); }
  .archetype b { color: var(--ink); font-weight: 500; }
  .piece-name { font: 500 26px/1.2 var(--serif); margin: 0 0 6px; }
  .piece-name .accent { color: var(--vermilion); }
  .intro { max-width: 36em; }
  figure { margin: 0; }
  figure.render { margin: 24px 0 12px; text-align: center; }
  figure.render img, figure.render svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  figcaption, .note { font: 12px/1.5 var(--mono); color: var(--steel); margin-top: 8px; }
  .ortho { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--rule); text-align: center; }
  .ortho > svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  .ortho svg text.caption { fill: var(--ink); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
  /* the build pack's workshop drawings, recoloured: steel plates, concrete base, thin lines */
  .ortho svg path { fill: var(--steel); fill-opacity: .9; stroke: var(--scale); stroke-width: .5; }
  .ortho svg path[fill="none"] { fill: none; }
  .ortho svg path.base, .ortho svg rect { fill: var(--concrete); fill-opacity: 1; stroke: var(--scale); stroke-width: .6; }
  .ortho svg line { stroke: var(--steel); }
  .ortho svg text { fill: var(--steel); font-family: var(--mono); font-size: 10px; }
  .terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 32px; }
  .terms > div { padding: 18px 0; border-top: 1px solid var(--rule); }
  .terms h2, .spec summary { font: 500 11px/1.4 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--steel); margin: 0 0 10px; }
  .terms .figure { font: 500 26px/1.25 var(--serif); margin: 0 0 6px; }
  .terms p { margin: 0 0 8px; }
  .est { font: 12px var(--mono); color: var(--steel); }
  .tbc { color: var(--vermilion); font: 13px/1.4 var(--mono); border-bottom: 1px dashed currentColor; }
  details.spec { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); padding: 14px 0; }
  .spec summary { cursor: pointer; margin: 0; list-style: none; }
  .spec summary::-webkit-details-marker { display: none; }
  .spec summary::after { content: ' +'; }
  .spec[open] summary::after { content: ' −'; }
  .spec dl { display: grid; grid-template-columns: minmax(110px, 160px) 1fr; gap: 6px 20px; margin: 18px 0 4px; font: 13px/1.5 var(--mono); }
  .spec dt { color: var(--steel); } .spec dd { margin: 0; }
  footer.sign { padding-top: 32px; font: 13px/1.6 var(--mono); color: var(--steel); }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; justify-content: flex-end; padding: 10px 0; background: var(--paper); }
  .bar button { font: 500 12px var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 8px 14px; border: 1px solid var(--ink); background: transparent; color: var(--ink); cursor: pointer; }
  .bar button:hover { background: var(--ink); color: var(--paper); }
  @media (max-width: 560px) { .meta { text-align: left; } .spec dl { grid-template-columns: 1fr; } .spec dt { margin-top: 6px; } }
  @media print {
    html, body { background: #fff; } body { max-width: none; padding: 0; }
    .bar { display: none; }
    details.spec > :not(summary) { display: block; }
    section { break-inside: avoid; }
  }
</style></head>
<body>
<div class="bar"><button type="button" onclick="document.querySelectorAll('details').forEach(function (d) { d.open = true; }); window.print()">Print / Save PDF</button></div>
<header class="mast"><span class="wordmark" aria-label="ECTYPE">ECTYPE</span><span class="meta">${spec.client.trim() ? `Prepared for ${esc(spec.client.trim())}` : `Prepared for ${tbc('client')}`}<br>${esc(date)}</span></header>

<section class="place" data-section="place">
<h1>${place ? esc(place) : tbc('place')}</h1>
${spec.quote.trim() ? `<blockquote>${paras(spec.quote)}${spec.quoteBy.trim() ? `<footer>${esc(spec.quoteBy.trim())}</footer>` : `<footer>${tbc('source of quotation')}</footer>`}</blockquote>` : `<blockquote><p>${tbc('local quotation')}</p></blockquote>`}
<p class="archetype"><b>Archetype:</b> ${archetype ? esc(archetype) : tbc('source')}</p>
</section>

<section class="piece" data-section="render">
<p class="piece-name">ECTYPE No. ${number ? esc(number) : tbc('number')} <span class="accent">—</span> ${esc(name)}</p>
${spec.intro.trim() ? `<div class="intro">${paras(spec.intro)}</div>` : ''}
<figure class="render">${picture}<figcaption>${hero ? `Rendered in Strata (${esc(hero.date)}), not a photograph.` : 'Drawn in Strata from the design, not a photograph.'}</figcaption></figure>
<figure class="ortho" data-scale="${views.scale.toFixed(4)}">${views.ortho}<figcaption>Front, side and plan, drawn at one scale. Sizes in millimetres.</figcaption></figure>
</section>

<section class="terms" data-section="terms">
<div><h2>Price</h2><p class="figure">${price}</p>${spec.priceEst && spec.price.trim() ? '<p class="note">An estimate, not yet backed by a supplier quote.</p>' : ''}</div>
<div><h2>Timeline</h2><p>${or(spec.timeline, 'timeline')}</p></div>
<div><h2>Finish and upkeep</h2><p>${or(spec.finish, 'finish')}</p><p>${or(spec.upkeep, 'upkeep')}</p></div>
</section>

<details class="spec" data-section="spec">
<summary>Technical sheet</summary>
<dl>${spec_.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join('')}</dl>
</details>

<footer class="sign">${spec.contact.trim() ? esc(spec.contact.trim()) : tbc('contact')}<br>Made with Strata.</footer>
</body></html>
`;
}
