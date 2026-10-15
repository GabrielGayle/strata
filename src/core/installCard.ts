// The shadow kitchen's install card: one printable page that says how to set
// the piece down so the carved pictures land where and when they were designed
// to (which way it faces, level, where the screen goes, and the frame times
// across the date window).
import type { Values } from './params';
import type { Project } from './project';
import { frameMatch, windowDays, type ShadowReport } from './shadow';
import { clock, shiftSite, siteOf, sunPosition } from './sun';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const point = (b: number) => COMPASS[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mm = (x: number) => `${Math.round(x)} mm`;

/** Top view: the base, its front, and north, turned so the front is at the bottom. */
function compassSvg(facing: number): string {
  // the front looks down the page; north sits (facing) degrees anticlockwise from straight down... i.e. rotate by 180 - facing
  const rot = 180 - facing;
  return `<svg viewBox="-66 -70 132 136" width="190" height="196" role="img" aria-label="Top view: the front faces ${Math.round(facing)}°">
  <circle r="54" fill="none" stroke="#999" stroke-dasharray="2 3"/>
  <rect x="-34" y="-16" width="68" height="32" fill="#d8d2c6" stroke="#333"/>
  <line x1="-34" y1="16" x2="34" y2="16" stroke="#e0701c" stroke-width="4"/>
  <text y="30" text-anchor="middle" font-size="8" fill="#e0701c">FRONT</text>
  <g transform="rotate(${rot})">
    <path d="M0,-52 L5,-40 L0,-43 L-5,-40 Z" fill="#222"/>
    <text y="-56" text-anchor="middle" font-size="9" font-weight="700" transform="rotate(${-rot} 0 -59)">N</text>
  </g>
</svg>`;
}

export function installCardHtml(project: Project, v: Values, rep: ShadowReport): string {
  const site = siteOf(v);
  const frames = project.shadow?.frames ?? [];
  const allDay = v.shadowExec === 'allday';
  const used = allDay ? frames.slice(0, 1) : frames;
  const facing = Number(v.sunFacing) || 0;
  const days = windowDays(v);
  const dates = [...new Set([days[0], 0, days[days.length - 1]])];
  const dateName = (d: number) => {
    const s = shiftSite(site, d);
    return `${s.day} ${MONTHS[s.month - 1]}`;
  };
  const g = rep.geom;
  const screen =
    g.screen === 'wall'
      ? `A flat pale wall or panel, square to the stack, ${mm(Number(v.shadowGap) || 0)} behind the back plate. The picture area is ${mm(Number(v.shadowW))} wide × ${mm(Number(v.shadowH))} tall, its bottom ${mm(g.y0)} above the ground the base stands on${Math.abs(Number(v.shadowX) || 0) > 0.5 ? `, centred ${mm(Math.abs(Number(v.shadowX)))} to the ${Number(v.shadowX) > 0 ? 'right' : 'left'} of the middle (looking from the front)` : ', centred on the middle'}.`
      : g.screen === 'ground'
        ? `Level, pale ground behind the piece. The picture area starts ${mm(Number(v.shadowGap) || 0)} behind the back plate and runs ${mm(Number(v.shadowH))} further back, ${mm(Number(v.shadowW))} wide.`
        : `The top of the concrete, from ${mm(Number(v.shadowGap) || 0)} behind the back plate. Keep it clean and pale.`;
  // a 1° lean moves the light by about the screen's distance from the middle of the stack × tan 1°
  const lean = Math.abs(g.wallS) * Math.tan(Math.PI / 180);
  const rows = used
    .map((f, i) => {
      const sc = rep.scores[i];
      const cells = dates
        .map((d) => {
          if (!sc || sc.problem) return '<td>—</td>';
          const m = frameMatch(v, rep, i, f.time, d).match;
          return `<td>${Math.round(m * 100)}%</td>`;
        })
        .join('');
      const pos = sunPosition(site, f.time);
      return `<tr><td><img src="${esc(f.dataUrl)}" alt=""></td><td>${esc(f.name)}</td><td class="t">${allDay ? 'all day' : clock(f.time)}${!allDay && f.hold ? ` <small>±${Math.round(f.hold / 2)} min</small>` : ''}</td><td>${pos.elevation.toFixed(0)}° up, ${point(pos.azimuth)}</td>${cells}</tr>`;
    })
    .join('\n');
  const utc = site.utc === 0 ? 'UTC' : `UTC${site.utc > 0 ? '+' : ''}${site.utc}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(project.name)} install card</title>
<style>
  body { font: 13px/1.45 system-ui, sans-serif; color: #222; max-width: 760px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 14px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .06em; }
  .sub { color: #666; margin: 0 0 12px; }
  .top { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  .big { font-size: 28px; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { font-size: 11px; color: #666; font-weight: 600; } td.t { font-weight: 700; white-space: nowrap; }
  td img { height: 36px; border: 1px solid #ccc; display: block; }
  ol { padding-left: 18px; } li { margin: 3px 0; }
  .note { color: #666; font-size: 12px; }
  @media print { body { margin: 0 auto; } a { color: inherit; } }
</style></head>
<body>
<h1>${esc(project.name)}: install card</h1>
<p class="sub">Shadow pictures carved for ${site.lat.toFixed(2)}° ${site.lat >= 0 ? 'N' : 'S'}, ${Math.abs(site.lon).toFixed(2)}° ${site.lon >= 0 ? 'E' : 'W'}, around ${dateName(0)}${days.length > 1 ? ` (${dateName(days[0])} to ${dateName(days[days.length - 1])})` : ''}. Times are clock times at ${utc}.</p>
<div class="top">
  ${compassSvg(facing)}
  <div>
    <div class="big">Front faces ${Math.round(facing)}° (${point(facing)})</div>
    <p>Point the front of the piece (the orange edge) ${Math.round(facing)}° clockwise from true north. Use true north, not a phone compass reading uncorrected: in the UK magnetic north is within about 1° of true, elsewhere it can be much more.</p>
  </div>
</div>
<h2>Setting it down</h2>
<ol>
  <li>Stand the base on firm, level ground and check it with a spirit level both ways. A 1° lean moves the picture about ${mm(Math.max(1, lean))} on the screen.</li>
  <li>Turn it so the front faces ${Math.round(facing)}° (${point(facing)}). Every degree of turn shifts each frame's time by about 4 minutes.</li>
  <li>Screen: ${screen}</li>
  <li>Nothing taller than the plates should stand between the sun and the front of the piece at the times below.</li>
</ol>
<h2>When the pictures show</h2>
<table>
  <thead><tr><th></th><th>Frame</th><th>Time</th><th>Sun</th>${dates.map((d) => `<th>${dateName(d)}</th>`).join('')}</tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="note">The percentages are how closely each picture comes out at its time on that date (100% is a perfect match). Clouds aside, they fade further away from these dates. If the clocks change while it's up, the pictures stay with the sun: add or take away the hour.</p>
<p class="note">Made with Strata.</p>
</body></html>
`;
}
