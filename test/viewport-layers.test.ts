import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { DEFAULT_VIEWPORT_LAYERS, loadViewportLayers, saveViewportLayers, showBaseMesh, showInsertMesh, showObject, showRodsLayerToggle } from '../src/ui/viewportLayers';
import { tabOwns } from '../src/ui/ObjectsPanel';
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

  it('hides the concrete base with the Base button alone', () => {
    expect(showBaseMesh(DEFAULT_VIEWPORT_LAYERS)).toBe(true);
    // the old bug: Concrete still on drew the base after Base was turned off
    expect(showBaseMesh({ ...DEFAULT_VIEWPORT_LAYERS, base: false })).toBe(false);
    // a session stored with only Concrete off keeps the base hidden
    expect(showBaseMesh({ ...DEFAULT_VIEWPORT_LAYERS, concrete: false })).toBe(false);
  });

  it('turning Base back on also clears an old Concrete off', () => {
    const st = useStore.getState();
    st.setUi({ viewportLayers: { ...DEFAULT_VIEWPORT_LAYERS, concrete: false } });
    st.toggleViewportLayer('base'); // off
    st.toggleViewportLayer('base'); // on
    expect(showBaseMesh(useStore.getState().ui.viewportLayers)).toBe(true);
    st.setUi({ viewportLayers: { ...DEFAULT_VIEWPORT_LAYERS } });
  });

  it('shows and hides objects all at once or one by one', () => {
    expect(showObject(DEFAULT_VIEWPORT_LAYERS, [], 'o1')).toBe(true);
    expect(showObject({ ...DEFAULT_VIEWPORT_LAYERS, objects: false }, [], 'o1')).toBe(false);
    expect(showObject(DEFAULT_VIEWPORT_LAYERS, ['o1'], 'o1')).toBe(false);
    expect(showObject(DEFAULT_VIEWPORT_LAYERS, ['o1'], 'candle2')).toBe(true);
    // an older stored set of layers has no Objects key: objects stay shown
    mem['strata.viewport.layers.v1'] = JSON.stringify({ grid: true });
    expect(loadViewportLayers().objects).toBe(true);
  });

  it('lists each object under its own tab, never a candle well', () => {
    const o = (id: string, look?: 'hidden' | 'candle') => ({ id, name: id, kind: 'box' as const, w: 1, h: 1, d: 1, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, clearance: 0, on: true, ...(look ? { look } : {}) });
    expect(tabOwns('objects', o('o1'))).toBe(true);
    expect(tabOwns('objects', o('shelf1'))).toBe(false);
    expect(tabOwns('shelf', o('shelf1'))).toBe(true);
    expect(tabOwns('candles', o('candle1', 'candle'))).toBe(true);
    expect(tabOwns('candles', o('well1', 'hidden'))).toBe(false);
    expect(tabOwns('objects', o('well1', 'hidden'))).toBe(false);
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
