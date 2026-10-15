import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { assemble, createDeferredPipeline, createFrontPipeline, deferredInput } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { installCardHtml } from '../src/core/installCard';
import { buildZip } from '../src/core/exporters';
import { stillTimes } from '../src/ui/VideoPicker';
import type { Gray } from '../src/core/image';

const disc: Gray = { w: 20, h: 20, data: Float32Array.from({ length: 400 }, (_, i) => ((i % 20) - 10) ** 2 + (Math.floor(i / 20) - 10) ** 2 < 40 ? 1 : 0) };

function setup() {
  const p = newProject();
  p.name = 'Garden <piece>';
  p.params = { ...p.params, sunOn: true, shadowOn: true, sunMonth: '12', sunDay: 21, sunFacing: 170, insertOn: false, shadowDays: 14 };
  p.shadow = { frames: [{ id: 'a', name: 'Disc', dataUrl: 'data:image/png;base64,AA', time: 12, hold: 4 }] };
  const assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null, shadowFrames: [disc] };
  const f = createFrontPipeline()(p, assets);
  return { p, f };
}

describe('install card', () => {
  it('says which way to face it, where the screen goes, and when each frame shows', () => {
    const { p, f } = setup();
    const html = installCardHtml(p, f.v, f.shadow!);
    expect(html).toContain('Front faces 170° (S)');
    expect(html).toContain('Garden &lt;piece&gt;');
    expect(html).toContain('behind the back plate');
    expect(html).toContain('<td class="t">12:00');
    // the window's first day, the set date and its last day
    expect(html).toContain('<th>14 Dec</th><th>21 Dec</th><th>28 Dec</th>');
    expect(html).toMatch(/<td>\d+%<\/td>/);
  });

  it('rides along in the ZIP when there are shadow pictures', () => {
    const { p, f } = setup();
    const m = assemble(f, createDeferredPipeline()(deferredInput(f, p), 'full'));
    const files = unzipSync(buildZip(m, p));
    expect(strFromU8(files['shadow-install-card.html'])).toContain('install card');
  });
});

describe('video stills', () => {
  it('are spread evenly over the chosen stretch, both ends included', () => {
    expect(stillTimes(2, 6, 5)).toEqual([2, 3, 4, 5, 6]);
    expect(stillTimes(0, 10, 1)).toEqual([5]);
  });
});
