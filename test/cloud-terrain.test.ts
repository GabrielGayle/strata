// Cloud terrain job (plan PR 8): the same map build at up to 2048 px, keyed by engine and
// request, saved as a 1024 px copy; and with Boost off the app makes no /api/geo request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, geoJobKey, validateGeoJobRequest } from '../api/_lib/geoJob';
import { runTerrainJob, terrainJobRequest } from '../src/core/cloudTerrain';
import { decodeDepthBuffers } from '../src/core/depth';
import { eaWcsScaleFactor } from '../src/core/mapEaWcs';
import type { Float32Grid } from '../src/core/mapGrid';
import { buildMapBundle, mapStackFromProject } from '../src/core/mapPipeline';
import { MAP_CLOUD_MAX_PX, MAP_FALLBACK_MAX_PX, mapGridSize, metricBounds } from '../src/core/mapProject';
import { defaultMapSpec, type MapSpec } from '../src/core/mapSpec';
import { deserialize, newProject, serialize, type Project } from '../src/core/project';
import { BUTTERMERE_BBOX, NEASDEN_BBOX } from './map-fixtures';

/** Rolling fells with one sharp summit, on the EPSG:27700 grid an EA WCS reply would have at `cellM`. */
function fells(bbox: [number, number, number, number], cellM: number): Float32Grid {
  const b = metricBounds(bbox, 'EPSG:27700');
  const w = Math.ceil((b.east - b.west) / cellM);
  const h = Math.ceil((b.north - b.south) / cellM);
  const data = new Float32Array(w * h);
  const cx = (b.east - b.west) * 0.62;
  const cy = (b.north - b.south) * 0.41;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const x = c * cellM;
      const y = r * cellM;
      const peak = 300 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 400 ** 2));
      data[r * w + c] = 120 + 150 * Math.sin(x / 900) * Math.cos(y / 700) + peak;
    }
  }
  return { w, h, data, crs: 'EPSG:27700', transform: { originX: b.west + cellM / 2, originY: b.north - cellM / 2, pixelW: cellM, pixelH: -cellM } };
}

const eaLoader = (bbox: [number, number, number, number]) => async (_s: unknown, sized: { resM?: number; maxSide?: number; bbox: number[] }) =>
  fells(bbox, 1 / eaWcsScaleFactor(bbox, sized.resM ?? 8, sized.maxSide));

function mapProject(spec: MapSpec): Project {
  const p = newProject();
  p.params = { ...p.params, plateCount: '93', thickness: '1.5', baseLength: '500', baseWidth: '380' };
  p.images.top = { name: 'map', dataUrl: '', map: spec };
  return p;
}

const noNetwork = async () => {
  throw new Error('no network in tests');
};

describe('cloud terrain job', () => {
  it('cuts EA at 0.25 mm per cell up to 2048 px, and leaves Terrarium at 512 px', () => {
    const ea = mapGridSize(defaultMapSpec({ bbox: BUTTERMERE_BBOX, source: 'ea-dtm' }), 'ea-dtm', 500, MAP_CLOUD_MAX_PX);
    expect(ea.maxSide).toBe(2048);
    // 8.2 km across 500 mm: 0.25 mm is 4.1 m of ground
    expect(ea.resM).toBeCloseTo(4.1, 1);
    const terrarium = mapGridSize(defaultMapSpec({ bbox: BUTTERMERE_BBOX, source: 'terrarium' }), 'terrarium', 500, MAP_CLOUD_MAX_PX);
    expect(terrarium.maxSide).toBe(MAP_FALLBACK_MAX_PX);
  });

  it('builds Buttermere at 2048 px with true metres and the summit kept', async () => {
    const spec = defaultMapSpec({ bbox: BUTTERMERE_BBOX, source: 'ea-dtm', water: 'raw', engrave: { enabled: false, features: [] } });
    const req = terrainJobRequest(mapProject(spec), spec, 2048, 'test');
    const stages: string[] = [];
    const asset = await runTerrainJob(req, { eaLoader: eaLoader(BUTTERMERE_BBOX), allowOverpassNetwork: false, fetch: noNetwork, onStage: (_d, s) => stages.push(s) });
    const d = asset.depth!;
    expect(Math.max(d.w, d.h)).toBe(2048);
    const src = fells(BUTTERMERE_BBOX, 4.1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of src.data) (lo = Math.min(lo, v), (hi = Math.max(hi, v)));
    // true metres, measured after smoothing: the summit and the lowest ground keep their heights
    expect(d.mapOrtho!.zMaxM).toBeCloseTo(hi, 0);
    expect(d.mapOrtho!.zMinM).toBeCloseTo(lo, 0);
    expect(stages.at(-1)).toBe('done');
    expect(asset.map?.resolvedSource).toBe('ea-dtm');
  });

  it('builds the same grid on the server at 1024 px as the local build, to 0.01 m per cell', async () => {
    const spec = defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'ea-dtm', water: 'raw', exaggeration: 4, engrave: { enabled: false, features: [] } });
    const project = mapProject(spec);
    const opts = { eaLoader: eaLoader(NEASDEN_BBOX), allowOverpassNetwork: false, fetch: noNetwork };
    const cloud = (await runTerrainJob(terrainJobRequest(project, spec, 1024, 'test'), opts)).depth!;
    const local = (await buildMapBundle(spec, { ...opts, stack: mapStackFromProject(project, spec.layerBudget) })).depth;
    expect([cloud.w, cloud.h]).toEqual([local.w, local.h]);
    const a = decodeDepthBuffers(cloud).metres;
    const b = decodeDepthBuffers(local).metres;
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThan(0.01);
  });

  it('saves a cloud-built map as a 1024 px copy under 4 MB, keeping its cloud key', async () => {
    const spec = defaultMapSpec({ bbox: BUTTERMERE_BBOX, source: 'ea-dtm', water: 'raw', engrave: { enabled: false, features: [] } });
    const project = mapProject(spec);
    const asset = await runTerrainJob(terrainJobRequest(project, spec, 2048, 'test'), { eaLoader: eaLoader(BUTTERMERE_BBOX), allowOverpassNetwork: false, fetch: noNetwork });
    asset.map = { ...asset.map!, cloudBuilt: { key: 'f'.repeat(32), px: 2048 } };
    project.images.top = asset;
    const text = serialize(project);
    expect(text.length).toBeLessThan(4e6);
    const back = deserialize(text);
    expect(Math.max(back.images.top!.depth!.w, back.images.top!.depth!.h)).toBe(1024);
    expect(back.images.top!.map!.cloudBuilt).toEqual({ key: 'f'.repeat(32), px: 2048 });
    // the copy is the full grid averaged: same heights in metres at the same spots
    const full = decodeDepthBuffers(asset.depth!).metres;
    const half = decodeDepthBuffers(back.images.top!.depth!).metres;
    const w = asset.depth!.w;
    const hw = back.images.top!.depth!.w;
    for (const [c, r] of [[100, 200], [700, 300], [1000, 900]]) {
      const avg = (full[2 * r * w + 2 * c] + full[2 * r * w + 2 * c + 1] + full[(2 * r + 1) * w + 2 * c] + full[(2 * r + 1) * w + 2 * c + 1]) / 4;
      expect(half[r * hw + c]).toBeCloseTo(avg, 1);
    }
    // the live project still holds the full grid
    expect(project.images.top!.depth!.w).toBe(w);
  });

  it('keys a job on the engine and the request, not on key order or build outputs', async () => {
    const spec = defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'ea-dtm' });
    const project = mapProject(spec);
    const req = terrainJobRequest(project, spec, 2048, 'e1');
    const key = await geoJobKey(req);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const shuffled = JSON.parse(canonicalJson(req));
    expect(await geoJobKey({ ...shuffled, spec: Object.fromEntries(Object.entries(shuffled.spec).reverse()) })).toBe(key);
    const built = terrainJobRequest(project, { ...spec, buildKey: 'x', fetchedAt: 'now', cloudBuilt: { key: 'a'.repeat(32), px: 2048 }, cloudRes: true }, 2048, 'e1');
    expect(await geoJobKey(built)).toBe(key);
    expect(await geoJobKey(terrainJobRequest(project, spec, 2048, 'e2'))).not.toBe(key);
    expect(await geoJobKey(terrainJobRequest(project, spec, 1024, 'e1'))).not.toBe(key);
    expect(await geoJobKey(terrainJobRequest(project, { ...spec, exaggeration: 3 }, 2048, 'e1'))).not.toBe(key);
    expect(validateGeoJobRequest(JSON.parse(JSON.stringify(req)))).toMatchObject({ ok: true });
  });
});

describe('Boost off', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('makes no /api/geo request, whatever is asked of the cloud', async () => {
    const store: Record<string, string> = { 'strata.owner.token': 'owner-pass' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const cloud = await import('../src/state/cloud');
    expect(cloud.useCloud.getState().boost).toBe(false);
    expect(cloud.cloudStatusText(cloud.useCloud.getState())).toBe('Cloud: off');
    const spec = defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'ea-dtm', cloudRes: true });
    await expect(cloud.runCloudJob(terrainJobRequest(mapProject(spec), spec))).rejects.toThrow(cloud.CloudUnavailableError);
    await cloud.checkCloud();
    expect(await cloud.cloudUsage()).toBeNull();
    await expect(cloud.fetchCloudAsset('a'.repeat(32))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(cloud.cloudReady()).toBe(false);
  });

  it('turning Boost on without the owner passphrase locks without a request', async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const cloud = await import('../src/state/cloud');
    cloud.useCloud.getState().setBoost(true);
    await vi.waitFor(() => expect(cloud.useCloud.getState().phase).toBe('locked'));
    expect(store['strata.boost']).toBe('on');
    expect(cloud.cloudStatusText(cloud.useCloud.getState())).toBe('Cloud: locked');
    expect(fetch).not.toHaveBeenCalled();
    cloud.useCloud.getState().setBoost(false);
    expect(store['strata.boost']).toBeUndefined();
  });

  it('shows working n% and resting with a reason', async () => {
    const { cloudStatusText } = await import('../src/state/cloud');
    expect(cloudStatusText({ boost: true, phase: 'working', progress: 0.42 })).toBe('Cloud: working 42%');
    expect(cloudStatusText({ boost: true, phase: 'resting', progress: 0, reason: 'offline' })).toBe('Cloud: resting: offline');
    expect(cloudStatusText({ boost: true, phase: 'ready', progress: 0 })).toBe('Cloud: ready');
  });
});
