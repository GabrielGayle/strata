import { describe, expect, it } from 'vitest';
import { dragKinds, dropTargets, fileKind } from '../src/ui/dropTargets';

describe('window drop targets', () => {
  it('sorts files by name and type', () => {
    expect(fileKind('fin.stl')).toBe('mesh');
    expect(fileKind('FIN.OBJ')).toBe('mesh');
    expect(fileKind('part.step')).toBe('mesh');
    expect(fileKind('Vermilion.strata.json', 'application/json')).toBe('project');
    expect(fileKind('cliff.jpg', 'image/jpeg')).toBe('image');
    expect(fileKind('scan', 'image/png')).toBe('image');
    expect(fileKind('clip.mov', 'video/quicktime')).toBe('video');
    expect(fileKind('notes.txt', 'text/plain')).toBeNull();
  });

  it('guesses kinds from drag item types', () => {
    expect([...dragKinds(['image/png', 'image/jpeg'])]).toEqual(['image']);
    expect(dragKinds(['']).has('mesh')).toBe(true);
    expect(dragKinds(['application/json']).has('project')).toBe(true);
    expect(dragKinds([]).size).toBe(4);
  });

  it('offers the surfaces, or the shadow frames while the shadow view is up', () => {
    const imgs = new Set(['image'] as const);
    expect(dropTargets(imgs, false).map((t) => t.id)).toEqual(['side', 'front', 'top']);
    expect(dropTargets(imgs, true).map((t) => t.id)).toEqual(['shadow']);
    expect(dropTargets(new Set(['mesh', 'project'] as const), false).map((t) => t.id)).toEqual(['ins', 'src', 'open']);
    expect(dropTargets(new Set(['video'] as const), false).map((t) => t.id)).toEqual(['video']);
  });
});
