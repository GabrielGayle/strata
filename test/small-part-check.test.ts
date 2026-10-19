import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/core/checks';

const rect = (w: number, h: number) => [{ outer: [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]] as [number, number][], holes: [] }];
const part = (w: number, h: number) => ({ id: 'S-07', shape: rect(w, h), bbox: { minX: -w / 2, minY: 0, maxX: w / 2, maxY: h }, anchored: true, labelAt: [0, h / 2], thickness: 3 });
const v = { minPartSize: 15, minFeature: 0, kerf: 0, sheetW: 2500, sheetH: 1250, partSpacing: 6, pitch: 10, thickness: 3, sliceMode: 'parallel', baseOn: false };

describe('small part check', () => {
  it('says which way a long low plate is too small and puts no marker on its label', () => {
    const issues = runChecks(v as never, { plates: [], parts: [part(424, 13)], warnings: [] } as never).filter((i) => i.type === 'small');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Part is only 13.0 mm tall (Min part size 15 mm, under Fabrication).');
    expect(issues[0].at).toBeUndefined();
  });
  it('leaves parts at or above the minimum alone', () => {
    expect(runChecks(v as never, { plates: [], parts: [part(424, 15)], warnings: [] } as never).some((i) => i.type === 'small')).toBe(false);
  });
});
