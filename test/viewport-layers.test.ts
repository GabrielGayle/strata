import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { DEFAULT_VIEWPORT_LAYERS, loadViewportLayers, saveViewportLayers, showInsertMesh, showRodsLayerToggle } from '../src/ui/viewportLayers';
import { useStore } from '../src/state/store';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('viewport layer toggles', () => {
  const mem: Record<string, string> = {};
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => {
        mem[k] = v;
      },
      removeItem: (k: string) => {
        delete mem[k];
      },
      clear: () => {
        Object.keys(mem).forEach((k) => delete mem[k]);
      },
    });
    Object.keys(mem).forEach((k) => delete mem[k]);
  });

  it('persists in sessionStorage', () => {
    saveViewportLayers({ ...DEFAULT_VIEWPORT_LAYERS, grid: false, plates: false });
    expect(loadViewportLayers().grid).toBe(false);
    expect(loadViewportLayers().plates).toBe(false);
  });

  it('maps a stored Backing toggle onto Fin', () => {
    mem['strata.viewport.layers.v1'] = JSON.stringify({ backing: false, plates: true });
    expect(loadViewportLayers().fin).toBe(false);
    expect(loadViewportLayers().plates).toBe(true);
  });

  it('keeps the fin visible when plates are hidden', () => {
    expect(showInsertMesh({ ...DEFAULT_VIEWPORT_LAYERS, plates: false, fin: true })).toBe(true);
    expect(showInsertMesh({ ...DEFAULT_VIEWPORT_LAYERS, plates: true, fin: false })).toBe(false);
  });

  it('shows the Rods toggle on a flat stack, not on the default upright job', () => {
    expect(showRodsLayerToggle('parallel', { brace: null, stackRods: null })).toBe(false);
    expect(showRodsLayerToggle('flat', { brace: null, stackRods: null })).toBe(true);
    expect(showRodsLayerToggle('parallel', { brace: { rods: { rods: { length: 2 } } }, stackRods: null })).toBe(true);
  });

  it('does not change export geometry (plate count / BOM)', () => {
    const preset = PRESETS.find((p) => p.name === 'Vermilion 40')!;
    const project = applyPreset(newProject(), preset);
    const model = createPipeline()(project, assets);
    const plates = model.sliced.plates.length;
    const sheets = model.bom.sheets;
    useStore.getState().toggleViewportLayer('plates');
    useStore.getState().toggleViewportLayer('grid');
    const model2 = createPipeline()(useStore.getState().project, assets);
    expect(model2.sliced.plates.length).toBe(plates);
    expect(model2.bom.sheets).toBe(sheets);
  });
});
