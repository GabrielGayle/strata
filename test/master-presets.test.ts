import { describe, expect, it } from 'vitest';
import {
  FIXED_OUTLINE_MM,
  fixedOutlineMm,
  masterSizePresetPatch,
  outlineForMasterPreset,
  parseMasterOrientation,
  ratioOutlineMm,
  resolveMasterSizeCli,
} from '../src/core/masterPresets';
import { evaluateParams } from '../src/core/params';

describe('master size presets', () => {
  it('resolveMasterSizeCli accepts canonical ids', () => {
    expect(resolveMasterSizeCli('iphone-17')).toBe('iphone17');
    expect(resolveMasterSizeCli('A4')).toBe('a4');
    expect(resolveMasterSizeCli('16:9')).toBe('ratio16x9');
    expect(() => resolveMasterSizeCli('ledger')).toThrow(/unknown size 'ledger'/);
  });

  it('parseMasterOrientation', () => {
    expect(parseMasterOrientation('Portrait')).toBe('portrait');
    expect(() => parseMasterOrientation('wide')).toThrow(/unknown orientation/);
  });

  it('ISO A-series footprints in portrait', () => {
    expect(fixedOutlineMm('a4', 'portrait')).toEqual({ baseWidth: 210, baseLength: 297 });
    expect(fixedOutlineMm('a3', 'portrait')).toEqual({ baseWidth: 297, baseLength: 420 });
    expect(fixedOutlineMm('a5', 'portrait')).toEqual({ baseWidth: 148, baseLength: 210 });
    expect(fixedOutlineMm('a6', 'portrait')).toEqual({ baseWidth: 105, baseLength: 148 });
  });

  it('ISO A4 swaps for landscape', () => {
    expect(fixedOutlineMm('a4', 'landscape')).toEqual({ baseWidth: 297, baseLength: 210 });
  });

  it('iPhone 17 matches Apple width × height in portrait', () => {
    expect(FIXED_OUTLINE_MM.iphone17).toEqual({ short: 71.5, long: 149.6 });
    expect(fixedOutlineMm('iphone17', 'portrait')).toEqual({ baseWidth: 71.5, baseLength: 149.6 });
  });

  it('ratio presets keep the long edge', () => {
    const long = 800;
    expect(ratioOutlineMm('ratio16x9', 'portrait', long)).toEqual({ baseLength: 800, baseWidth: 450 });
    expect(ratioOutlineMm('ratio16x9', 'landscape', long)).toEqual({ baseWidth: 800, baseLength: 450 });
    expect(ratioOutlineMm('ratio4x3', 'portrait', long)).toEqual({ baseLength: 800, baseWidth: 600 });
    expect(ratioOutlineMm('ratio3x2', 'portrait', long).baseWidth).toBeCloseTo(800 * (2 / 3));
    expect(ratioOutlineMm('ratio3x2', 'portrait', long).baseLength).toBe(800);
    expect(ratioOutlineMm('ratio1x1', 'portrait', long)).toEqual({ baseLength: 800, baseWidth: 800 });
  });

  it('ratio outline uses evaluated footprint when master scale is not 1', () => {
    const raw = { baseLength: '800', baseWidth: '300', masterScale: '0.5' };
    const { values: v } = evaluateParams(raw);
    expect(v.baseLength).toBeCloseTo(400);
    const patch = masterSizePresetPatch(raw, 'ratio1x1', 'portrait');
    const after = evaluateParams({ ...raw, ...patch });
    expect(after.values.baseLength).toBeCloseTo(400);
    expect(after.values.baseWidth).toBeCloseTo(400);
    expect(after.values.masterScale).toBe(1);
  });

  it('fixed preset patch sets literals at master scale 1', () => {
    const patch = masterSizePresetPatch({ baseLength: '100', baseWidth: '50', masterScale: '2' }, 'a6', 'portrait');
    expect(patch).toMatchObject({ baseLength: '148', baseWidth: '105', masterScale: '1' });
    const { values } = evaluateParams(patch);
    expect(values.baseLength).toBe(148);
    expect(values.baseWidth).toBe(105);
  });

  it('outlineForMasterPreset picks long edge from current size for ratios', () => {
    expect(outlineForMasterPreset('ratio4x3', 'landscape', { baseLength: 300, baseWidth: 900 })).toEqual({
      baseWidth: 900,
      baseLength: 675,
    });
  });
});
