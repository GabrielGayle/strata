// Hero renders (plan PR 11): the design's model.glb is the same bytes wherever it is made,
// a render says what it shows and is refused when that isn't the design on screen, at most
// ten start a day, and a render that still shows the design goes into the build pack.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { handleGeoApi, type RenderCache } from '../api/_lib/geoApi';
import { artifactPath, geoJobKey, heroPrice, inputPartPath, validateGeoJobRequest, type HeroJobRequest } from '../api/_lib/geoJob';
import { main as cli } from '../src/cli';
import { runHeroModel, runPackJob } from '../src/cloudJobs';
import { buildZip } from '../src/core/exporters';
import { currentHero, defaultHeroCamera, heroFingerprint, heroFingerprintOf, heroGlb, heroScene, readHeroPng, stampHeroPng, windOutward, type HeroScene, type SavedHero } from '../src/core/hero';
import { createPipeline } from '../src/core/pipeline';
import { deserialize, serialize, type Project } from '../src/core/project';
import { resultKey } from '../src/core/resultCache';
import { loadAssets } from '../src/packNode';

const FIXTURE = 'test/fixtures/projects/lucky-horseshoe.strata.json';
const text = readFileSync(FIXTURE, 'utf8');
const sha = createHash('sha256').update(text).digest('hex');
const quiet = { stdout: () => undefined, stderr: () => undefined };
const camera: HeroJobRequest['camera'] = { position: [180, 140, 220], target: [0, 30, 0], up: [0, 1, 0], fov: 32, aspect: 1.5 };

async function build(p: Project) {
  return createPipeline()(p, await loadAssets(p));
}

/** A real 2 × 1 PNG (what Blender writes, in miniature). */
function tinyPng(): Uint8Array {
  return new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAPAAH/2EZXKgAAAABJRU5ErkJggg==', 'base64'));
}

function readGlb(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(glb.length);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  const binLen = dv.getUint32(20 + jsonLen, true);
  expect(dv.getUint32(24 + jsonLen, true)).toBe(0x004e4942);
  return { json, binLen };
}

describe('model.glb', () => {
  it('holds every plate, the concrete, the candles and their flames, in metres, with the camera', async () => {
    const project = deserialize(text);
    const model = await build(project);
    const scene = heroScene(model, project);
    expect(scene.plates).toBe(model.sliced.plates.length);
    expect(scene.flames.length).toBe(7);
    const kinds = scene.meshes.map((m) => m.kind).sort();
    expect(kinds).toEqual(['concrete', 'plate', 'wax']);
    const { json, binLen } = readGlb(heroGlb(scene, camera));
    expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLen);
    for (const bv of json.bufferViews) expect(bv.byteOffset + bv.byteLength).toBeLessThanOrEqual(binLen);
    expect(json.materials.map((m: { name: string }) => m.name)).toContain('strata:plate');
    expect(json.materials.find((m: { name: string }) => m.name === 'strata:plate').extras.metal).toBe('steel');
    expect(json.nodes.filter((n: { name: string }) => n.name.startsWith('flame.')).length).toBe(7);
    const cam = json.nodes.find((n: { camera?: number }) => n.camera === 0);
    expect(cam.translation).toEqual([0.18, 0.14, 0.22]);
    // an 84 mm piece is 0.084 m across
    const width = scene.max[0] - scene.min[0];
    expect(width).toBeGreaterThan(0.05);
    expect(width).toBeLessThan(0.2);
  }, 120_000);

  it('is the same bytes from the CLI and from the cloud job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-glb-'));
    expect(await cli([FIXTURE, '--zip', join(dir, 'a.zip'), '--glb', join(dir, 'a.glb'), '--date', '2026-10-19'], quiet)).toBe(0);
    const project = deserialize(text);
    const scene = heroScene(await build(project), project);
    expect(Buffer.compare(readFileSync(join(dir, 'a.glb')), Buffer.from(heroGlb(scene, defaultHeroCamera(scene))))).toBe(0);
    const job = await runHeroModel({ kind: 'hero', engine: 'test', input: { sha, parts: 1 }, camera, light: 'candle', px: 1600 }, text);
    expect(Buffer.compare(Buffer.from(job.glb), Buffer.from(heroGlb(scene, camera)))).toBe(0);
    expect(job.meta).toMatchObject({ plates: scene.plates, parts: scene.parts, flames: 7 });
    expect([job.width, job.height]).toEqual([1600, 1067]);
    expect(job.light).toBe('candle');
  }, 180_000);

  it('a design with no candles is lit as the studio when asked for candlelight', async () => {
    const plain = JSON.parse(text);
    delete plain.candles;
    const job = await runHeroModel({ kind: 'hero', engine: 'test', input: { sha, parts: 1 }, camera: { ...camera, aspect: 0.8 }, light: 'candle', px: 1000 }, JSON.stringify(plain));
    expect(job.meta.flames).toBe(0);
    expect(job.light).toBe('studio');
    expect([job.width, job.height]).toEqual([800, 1000]);
  }, 180_000);
});

describe('fingerprint', () => {
  it('stays for the same design, and changes with the plates or their finish', async () => {
    const project = deserialize(text);
    const fp = heroFingerprint(await build(project), project);
    expect(heroFingerprint(await build(deserialize(text)), deserialize(text))).toBe(fp);
    const fewer = deserialize(text);
    fewer.params = { ...fewer.params, baseHeight: Number(fewer.params.baseHeight ?? 20) + 5 };
    expect(heroFingerprint(await build(fewer), fewer)).not.toBe(fp);
    const blackened = deserialize(text);
    blackened.appearance = { main: { finish: 'blackened' }, buckets: [], assign: {} };
    expect(heroFingerprint(await build(blackened), blackened)).not.toBe(fp);
  }, 180_000);

  it('a saved render does not change the engine result key', async () => {
    const project = deserialize(text);
    const assets = await loadAssets(project);
    const hero: SavedHero = { kind: 'hero', fingerprint: 'x', png: `data:image/png;base64,${Buffer.from(tinyPng()).toString('base64')}`, w: 2, h: 1, light: 'studio', date: '2026-10-19' };
    expect(resultKey({ ...project, hero }, assets)).toBe(resultKey(project, assets));
  }, 60_000);
});

describe('PNG stamp', () => {
  it('round-trips with a valid chunk CRC, and a PNG without one reads as unstamped', () => {
    const png = tinyPng();
    expect(readHeroPng(png)).toBeUndefined();
    const stamped = stampHeroPng(png, { fingerprint: 'abc', plates: 10, parts: 12 });
    expect(readHeroPng(stamped)).toEqual({ fingerprint: 'abc', plates: 10, parts: 12, w: 2, h: 1 });
    // the tEXt chunk sits right after IHDR with a CRC any PNG reader accepts
    const dv = new DataView(stamped.buffer);
    const len = dv.getUint32(33);
    expect(strFromU8(stamped.subarray(37, 41))).toBe('tEXt');
    expect(dv.getUint32(41 + len)).toBe(crc32(stamped.subarray(37, 41 + len)));
    expect(() => stampHeroPng(new Uint8Array(40), { fingerprint: 'a', plates: 1, parts: 1 })).toThrow('not a PNG');
  });
});

describe('build pack', () => {
  async function withHero(edit?: (p: Project) => void) {
    const project = deserialize(text);
    const model = await build(project);
    const fingerprint = heroFingerprint(model, project);
    const png = stampHeroPng(tinyPng(), { fingerprint, plates: model.sliced.plates.length, parts: model.sliced.parts.length });
    const hero: SavedHero = { kind: 'hero', fingerprint, png: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, w: 2, h: 1, light: 'candle', date: '2026-10-19' };
    // through a save and an open, as the app keeps it
    const saved = deserialize(serialize({ ...project, hero }));
    edit?.(saved);
    return { project: saved, model: await build(saved), png };
  }

  it('puts a render that still shows the design into the zip and on the cover', async () => {
    const { project, model, png } = await withHero();
    expect(currentHero(project, model)).toBeDefined();
    const files = unzipSync(buildZip(model, project, undefined, { date: new Date('2026-10-19T00:00:00Z') }));
    expect(Buffer.compare(Buffer.from(files['hero.png']), Buffer.from(png))).toBe(0);
    expect(strFromU8(files['build-pack.html'])).toContain('<figure class="full hero"><img src="data:image/png;base64,');
    expect(strFromU8(files['README.txt'])).toContain('hero.png');
  }, 180_000);

  it('leaves out a render of an earlier design', async () => {
    const { project, model } = await withHero((p) => {
      p.params = { ...p.params, baseHeight: Number(p.params.baseHeight ?? 20) + 5 };
    });
    expect(project.hero).toBeDefined();
    expect(currentHero(project, model)).toBeUndefined();
    const files = unzipSync(buildZip(model, project, undefined, { date: new Date('2026-10-19T00:00:00Z') }));
    expect(files['hero.png']).toBeUndefined();
    expect(strFromU8(files['build-pack.html'])).not.toContain('figure class="full hero"');
  }, 180_000);

  it('the cloud pack is still the CLI zip byte for byte with a render in the project', async () => {
    const { project } = await withHero();
    const dir = mkdtempSync(join(tmpdir(), 'strata-cli-'));
    const file = join(dir, 'p.strata.json');
    const body = serialize(project);
    writeFileSync(file, body);
    expect(await cli([file, '--zip', join(dir, 'a.zip'), '--date', '2026-10-19'], quiet)).toBe(0);
    const job = await runPackJob({ kind: 'pack', engine: 'test', input: { sha: createHash('sha256').update(body).digest('hex'), parts: 1 }, date: '2026-10-19' }, body);
    expect(Buffer.compare(Buffer.from(job.zip), readFileSync(join(dir, 'a.zip')))).toBe(0);
    expect(unzipSync(job.zip)['hero.png']).toBeDefined();
  }, 180_000);
});

describe('hero job requests', () => {
  const ok = { kind: 'hero', engine: 'abc123', input: { sha, parts: 1 }, camera, light: 'studio', px: 1600 };

  it('checks the camera, the light and the size', () => {
    expect(validateGeoJobRequest(ok).ok).toBe(true);
    expect(validateGeoJobRequest({ ...ok, light: 'disco' })).toMatchObject({ ok: false });
    expect(validateGeoJobRequest({ ...ok, px: 9000 })).toMatchObject({ ok: false });
    expect(validateGeoJobRequest({ ...ok, camera: { ...camera, fov: 0 } })).toMatchObject({ ok: false });
    expect(validateGeoJobRequest({ ...ok, camera: { ...camera, target: camera.position } })).toMatchObject({ ok: false });
    expect(validateGeoJobRequest({ ...ok, camera: { ...camera, position: [1, 2] } })).toMatchObject({ ok: false });
  });

  it('a camera nudged by a rounding error finds the same cached render', async () => {
    const a = validateGeoJobRequest(ok);
    const b = validateGeoJobRequest({ ...ok, camera: { ...camera, position: [180.0000001, 140, 219.9999999] } });
    if (!a.ok || !b.ok) throw new Error('invalid');
    expect(await geoJobKey(a.value)).toBe(await geoJobKey(b.value));
  });

  it('says the price before it runs: about a nickel, never more than ten cents', () => {
    const p = heroPrice();
    expect(p.typicalUsd).toBeGreaterThan(0.01);
    expect(p.maxUsd).toBeLessThanOrEqual(0.1);
    expect(p.typicalUsd).toBeLessThan(p.maxUsd);
  });
});

describe('/api/geo for hero renders', () => {
  const env = {
    STRATA_OWNER_TOKEN: 'owner-pass',
    MODAL_GEO_URL: 'https://example--strata-cloud-api.modal.run',
    MODAL_KEY: 'wk-secret-key',
    MODAL_SECRET: 'ws-secret-value',
    RENDER_CACHE_READ_WRITE_TOKEN: 'vercel_blob_rw_secret',
  } as NodeJS.ProcessEnv;
  const auth = 'Bearer owner-pass';
  const req = { kind: 'hero', engine: 'abc123', input: { sha, parts: 1 }, camera, light: 'studio', px: 1600 } as HeroJobRequest;
  const cache = (files: Record<string, Uint8Array>): RenderCache => ({ has: async (p) => p in files, get: async (p) => files[p], put: async (p, b) => void (files[p] = b) });

  it('passes the worker\'s daily limit on as 429 "limit", without the secrets', async () => {
    const files: Record<string, Uint8Array> = { [inputPartPath({ sha, parts: 1 }, 0)]: new Uint8Array([1]) };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: '10 hero renders a day: the next one can start tomorrow (UTC)', reason: 'limit' }), { status: 429 })) as unknown as typeof globalThis.fetch;
    const out = await handleGeoApi({ method: 'POST', path: 'jobs', authorization: auth, body: req }, { env, fetch, cache: cache(files) });
    expect(out.status).toBe(429);
    expect(out.json).toMatchObject({ reason: 'limit', error: expect.stringContaining('10 hero renders a day') });
    expect(JSON.stringify(out.json)).not.toMatch(/secret/);
  });

  it('answers a render already made from the cache, with no Modal call, and serves hero.png', async () => {
    const checked = validateGeoJobRequest(req);
    if (!checked.ok) throw new Error('invalid');
    const key = await geoJobKey(checked.value);
    const png = stampHeroPng(tinyPng(), { fingerprint: 'f', plates: 1, parts: 1 });
    const files: Record<string, Uint8Array> = { [artifactPath(key, 'hero.png')]: png };
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const out = await handleGeoApi({ method: 'POST', path: 'jobs', authorization: auth, body: req }, { env, fetch, cache: cache(files) });
    expect(out.json).toMatchObject({ status: 'done', key, cached: true });
    expect(fetch).not.toHaveBeenCalled();
    const art = await handleGeoApi({ method: 'GET', path: `artifacts/${key}/hero.png`, query: { part: '0' }, authorization: auth }, { env, fetch, cache: cache(files) });
    expect(art.status).toBe(200);
    expect(readHeroPng(art.bytes!)).toMatchObject({ fingerprint: 'f' });
  });
});

describe('windOutward', () => {
  it('rewinds a clockwise triangle to face its normals and leaves a good one alone', () => {
    const up = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const ccw = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const cw = [0, 0, 0, 0, 1, 0, 1, 0, 0];
    const [p, n] = windOutward(new Float32Array([...ccw, ...cw]), new Float32Array([...up, ...up]));
    expect(Array.from(p)).toEqual([...ccw, ...ccw]);
    expect(Array.from(n)).toEqual([...up, ...up]);
  });
});

describe('heroFingerprintOf', () => {
  it('ignores last-digit noise in flame positions (browser and cloud trig differ there)', () => {
    const scene: HeroScene = { meshes: [], flames: [{ p: [0.0142, 0.0955, -0.01994361264559773], size: 0.009 }], plates: 1, parts: 1, min: [0, 0, 0], max: [0, 0, 0] };
    const cloud = { ...scene, flames: [{ p: [0.0142, 0.0955, -0.019943612645597752] as [number, number, number], size: 0.009000000000000001 }] };
    expect(heroFingerprintOf(cloud)).toBe(heroFingerprintOf(scene));
    const moved = { ...scene, flames: [{ p: [0.0142, 0.0955, -0.0201] as [number, number, number], size: 0.009 }] };
    expect(heroFingerprintOf(moved)).not.toBe(heroFingerprintOf(scene));
  });
});
