import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject, PRESETS, type Project } from '../src/core/project';
import { masterShopping, masterText } from '../src/core/candleMaster';
import { buildPackHtmlChecked, buildZip } from '../src/core/exporters';
import { strFromU8, unzipSync } from 'fflate';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
const preset = PRESETS.find((p) => p.name === 'Candle master')!;
const project = (params: Record<string, unknown> = {}): Project => {
  const p = newProject();
  return { ...p, params: { ...p.params, ...preset.params, ...params } as Project['params'] };
};

describe('candle master', () => {
  it('cuts the candle into layers with a pin hole, each beside a frame that stacks into the box', () => {
    const m = createPipeline()(project(), assets);
    const s = m.sliced.candleMaster!;
    expect(s).toBeTruthy();
    // 120 mm candle in 3 mm layers, box 10 mm above it: 44 layers from the preset's plate count
    expect(m.sliced.plates.length).toBe(44);
    expect(s.masterLayers).toBe(40);
    expect(s.frameLayers).toBe(44);
    expect(s.height).toBe(120);
    expect(s.layersNeeded).toBe(44);
    expect(m.sliced.warnings.filter((w) => w.startsWith('Candle master'))).toEqual([]);
    // the bottom layer: the candle's section with the pin hole, and its frame
    const bottom = m.sliced.parts.filter((p) => p.plateKey === 'L0');
    expect(bottom.length).toBe(2);
    const [sec, frame] = [...bottom].sort((a, b) => a.area - b.area);
    expect(sec.shape[0].holes.length).toBe(1);
    expect(frame.shape[0].holes.length).toBe(1);
    // the frame's inside clears the widest part of the candle by the silicone wall (its outside adds the box wall)
    const widest = Math.max(...m.sliced.parts.filter((p) => p.bbox.maxX < frame.bbox.maxX - 1).map((p) => p.bbox.maxX));
    expect(frame.bbox.maxX - widest).toBeCloseTo(10 + 10, 0);
    // above the master only frames
    expect(m.sliced.parts.filter((p) => p.plateKey === 'L42').length).toBe(1);
    // silicone fills the box less the master; wax is the master
    expect(s.silicone).toBeCloseTo(s.inner.w * s.inner.d * s.inner.h - s.volume - Math.PI * 2 ** 2 * 10, -1);
    expect(s.volume / 1000).toBeGreaterThan(400);
    expect(s.volume / 1000).toBeLessThan(600);
    expect(s.pin).toEqual({ d: 4, length: 130 });
  });

  it('warns when the plates stop short of the box top', () => {
    const m = createPipeline()(project({ plateCount: '41' }), assets);
    expect(m.sliced.warnings.some((w) => w.includes('raise Plate count to 44'))).toBe(true);
  });

  it('leaves out the pin and the box when they are set to 0, and does nothing when off', () => {
    const bare = createPipeline()(project({ cmPin: '0', cmFrame: '0' }), assets);
    expect(bare.sliced.parts.filter((p) => p.plateKey === 'L0').length).toBe(1);
    expect(bare.sliced.parts[0].shape[0].holes.length).toBe(0);
    expect(masterShopping(bare.sliced.candleMaster!).map((r) => r.item)).toEqual(['Mould silicone', 'Candle wax']);
    const off = createPipeline()(project({ cmOn: false }), assets);
    expect(off.sliced.candleMaster).toBeNull();
    expect(off.sliced.parts.filter((p) => p.plateKey === 'L0').length).toBe(1);
  });

  it('puts the silicone, wax and pin in the build pack and candle-master.txt in the zip', () => {
    const p = project();
    const m = createPipeline()(p, assets);
    const html = buildPackHtmlChecked(p, m);
    expect(html).toContain('Mould silicone');
    expect(html).toContain('data-candle-master-layers="40"');
    const files = unzipSync(buildZip(m, p));
    const txt = strFromU8(files['candle-master.txt']);
    expect(txt).toBe(masterText(m.sliced.candleMaster!));
    expect(txt).toContain('Master: 40 layers, 120 mm tall');
    expect(strFromU8(files['README.txt'])).toContain('candle-master.txt');
  });
});

describe('candle master labels', () => {
  it('etches no part number on the top of the master, which every candle would carry', () => {
    const m = createPipeline()(project(), assets);
    const top = m.sliced.parts.filter((p) => p.plateKey === 'L39');
    expect(top.length).toBe(2);
    const [sec, frame] = [...top].sort((a, b) => a.area - b.area);
    expect(sec.labelPaths).toEqual([]);
    expect(frame.labelPaths.length).toBeGreaterThan(0);
    expect(m.sliced.parts.find((p) => p.plateKey === 'L38' && p.area < frame.area)!.labelPaths.length).toBeGreaterThan(0);
  });
});
