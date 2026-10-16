import { describe, expect, it } from 'vitest';
import { applyProjectPatch, diffProjectPatch, formatPatchDiff, masterSizePatch } from '../src/core/design/patch';
import { parseDesign } from '../src/core/design/parse';
import { DESIGN_PARAM_COVERAGE } from '../src/core/design/rules';
import { applyMasterSizeCli, loadProject, main, type CliIo } from '../src/cli';
import { defaultDepthSettings, type DepthData } from '../src/core/depth';
import { newProject } from '../src/core/project';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function sideDepth(w = 40, h = 10): DepthData {
  const minM = 1;
  const maxM = 20;
  const cells: number[] = [];
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) cells.push(10);
  const b = new Uint8Array(w * h * 2);
  cells.forEach((m, i) => {
    const q = 1 + Math.round(((m - minM) / (maxM - minM)) * 65534);
    b[i * 2] = q & 255;
    b[i * 2 + 1] = q >> 8;
  });
  return {
    w,
    h,
    minM,
    maxM,
    nearM: 1,
    farM: 15,
    data: btoa(String.fromCharCode(...b)),
    settings: defaultDepthSettings({ nearM: 1, farM: 15 }),
    focalLengthPx: 200,
  };
}

const example = fileURLToPath(new URL('../examples/image-cliff.strata.json', import.meta.url));

describe('design parser', () => {
  const ctx = () => ({ project: newProject() });

  it('covers documented param ids', () => {
    expect(DESIGN_PARAM_COVERAGE.length).toBeGreaterThan(20);
    expect(new Set(DESIGN_PARAM_COVERAGE).size).toBe(DESIGN_PARAM_COVERAGE.length);
  });

  it('parses plate count, thickness, material, and master size together', () => {
    const r = parseDesign('40 plates, 3mm steel, A4 landscape', ctx());
    expect(r.unrecognised).toEqual([]);
    expect(r.patch.params?.plateCount).toBe('40');
    expect(r.patch.params?.thickness).toBe('3');
    expect(r.patch.params?.plateMaterial).toBe('steel');
    expect(r.patch.masterSize?.id).toMatch(/a4/i);
    expect(r.patch.masterSize?.orientation).toBe('landscape');
  });

  it('accepts millimetre spelling', () => {
    const r = parseDesign('2.5 millimetre mild steel', ctx());
    expect(r.patch.params?.thickness).toBe('2.5');
    expect(r.patch.params?.plateMaterial).toBe('steel');
  });

  it('loads presets by name', () => {
    const r = parseDesign('preset Image cliff', ctx());
    expect(r.patch.preset).toBe('Image cliff');
  });

  it('maps cliff from this photo to side heightmap and flags leftover erosion phrase', () => {
    const text = 'cliff from this photo, more erosion on the left';
    const r = parseDesign(text, ctx());
    expect(r.patch.preset).toBe('Image cliff');
    expect(r.patch.params?.imgSideMode).toBe('heightmap');
    const left = text.slice(r.unrecognised[0]?.start ?? 0, r.unrecognised[0]?.end);
    expect(left).toMatch(/on the left/i);
  });

  it('maps blur types and amount', () => {
    const r = parseDesign('tilt-shift blur, blur amount 4', ctx());
    expect(r.patch.params?.imgBlurType).toBe('tilt');
    expect(r.patch.params?.imgSmooth).toBe('4');
  });

  it('maps tuning speech-like and quoted phrase', () => {
    const r = parseDesign('speech-like, phrase "FREE-PAL"', ctx());
    expect(r.patch.params?.tuneMode).toBe('speech');
    expect(r.patch.params?.tuneWords).toBe('FREE-PAL');
  });

  it('marks unknown phrases', () => {
    const phrase = '40 plates, xyzzy flarn';
    const r = parseDesign(phrase, ctx());
    expect(r.unrecognised.some((span) => phrase.slice(span.start, span.end).includes('xyzzy'))).toBe(true);
  });

  it('parses auto-dimension faces and relief exaggeration', () => {
    const r = parseDesign('auto dimension the side, exaggerate relief 2x', ctx());
    expect(r.patch.autoDimension?.faces).toEqual(['side']);
    expect(r.patch.autoDimension?.reliefExaggeration).toBe(2);
  });

  it('parses auto-dimension side, front list', () => {
    const r = parseDesign('auto dimension side, front', ctx());
    expect(r.patch.autoDimension?.faces).toEqual(['side', 'front']);
  });
});

describe('applyProjectPatch', () => {
  it('matches masterSizePatch and applyMasterSizeCli', () => {
    const text = readFileSync(example, 'utf8');
    const { project: a } = loadProject(text);
    const { project: b } = loadProject(text);
    applyMasterSizeCli(a, 'a4', 'landscape');
    const c = applyProjectPatch(b, masterSizePatch('a4', 'landscape'));
    expect(c.params.baseLength).toBe(a.params.baseLength);
    expect(c.params.baseWidth).toBe(a.params.baseWidth);
  });

  it('UI path and parse path produce the same diff', () => {
    const p = newProject();
    const instruction = '24 plates, 1.5mm steel, waffle';
    const { patch } = parseDesign(instruction, { project: p });
    const viaPatch = applyProjectPatch(p, patch);
    const viaSetParams = { ...p, params: { ...p.params, ...patch.params } };
    if (patch.params?.sliceMode) viaSetParams.params.sliceMode = patch.params.sliceMode;
    expect(viaPatch.params.plateCount).toBe(viaSetParams.params.plateCount);
    expect(viaPatch.params.thickness).toBe(viaSetParams.params.thickness);
    expect(viaPatch.params.sliceMode).toBe('waffle');
    const diff = diffProjectPatch(p, patch);
    expect(diff.changes.some((c) => c.id === 'plateCount')).toBe(true);
    expect(formatPatchDiff(p, patch)).toContain('plateCount');
  });

  it('applies auto-dimension from a parsed patch when metric depth exists', () => {
    const p = newProject();
    p.params.stackSource = 'strata';
    p.params.imgSideMode = 'heightmap';
    p.images.side = { name: 'side.png', dataUrl: 'data:image/png;base64,aa', depth: sideDepth() };
    const { patch } = parseDesign('auto dimension the side', { project: p });
    const after = applyProjectPatch(p, patch);
    expect(after.params.imgSideFit).toBe('length');
    expect(Number(after.params.imgRange)).toBeGreaterThan(0);
  });
});

describe('cli say', () => {
  function capture(): CliIo & { out: string; err: string } {
    const io = { out: '', err: '', stdout: (s: string) => { io.out += s; }, stderr: (s: string) => { io.err += s; } };
    return io;
  }

  it('prints diff and unrecognised spans', async () => {
    const io = capture();
    const code = await main([example, 'say', '40 plates, xyzzy'], io);
    expect(code).toBe(0);
    expect(io.out).toContain('plateCount');
    expect(io.out).toMatch(/unrecognised/i);
    expect(io.out).toContain('xyzzy');
  });

  it('applies patch to project params in memory when --apply', async () => {
    const io = capture();
    const code = await main([example, 'say', '--apply', '3mm steel'], io);
    expect(code).toBe(0);
    expect(io.out).toContain('thickness');
  });
});
