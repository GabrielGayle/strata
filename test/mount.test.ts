// Table or wall: the model never turns, only which way is up. These pin the frame
// (right-handed, picture top up), that a table piece's sun is exactly the old one,
// that wall keyholes are checked against the top edge, and that a wall piece goes to
// Blender turned into the room with its wall.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bearingDir, modelToRoom, mountFrame, mountIssues, mountWeightIssue, roomToModel, sunDir, sunBehindWall, wallTopEdge, type V3 } from '../src/core/mount';
import { defaultRaw, evaluateParams, type Values } from '../src/core/params';
import { bearingToWorld, sunVector } from '../src/core/sun';
import { defaultHeroCamera, heroGlb, heroScene } from '../src/core/hero';
import { createPipeline } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';
import { objectMatrix } from '../src/core/objects';
import { loadAssets } from '../src/packNode';

const values = (over: Record<string, string> = {}): Values => evaluateParams({ ...defaultRaw(), ...over }).values;
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));

describe('mount frame', () => {
  it('is the identity for a table piece', () => {
    const f = mountFrame(values());
    expect(f.mount).toBe('table');
    close(roomToModel(f, [1, 2, 3]), [1, 2, 3]);
  });

  it('hangs a wall piece with the base on the wall, right-handed, round trip exact', () => {
    for (const wallTop of ['picture', 'back', 'front', 'left', 'right']) {
      for (const sliceAxis of ['length', 'width']) {
        const f = mountFrame(values({ mount: 'wall', wallTop, sliceAxis }));
        close(f.toward, [0, 1, 0]);
        close(cross(f.up, f.toward), f.right);
        close(modelToRoom(f, roomToModel(f, [0.3, -2, 5])), [0.3, -2, 5]);
      }
    }
  });

  it('puts the top of the top picture at the top by default (north for a map)', () => {
    close(mountFrame(values({ mount: 'wall' })).up, [1, 0, 0]);
    close(mountFrame(values({ mount: 'wall', sliceAxis: 'width' })).up, [0, 0, 1]);
    close(mountFrame(values({ mount: 'wall' }), true).up, [-1, 0, 0]);
    // the top picture's right (+z for a length stack) is on the viewer's right
    close(mountFrame(values({ mount: 'wall' })).right, [0, 0, 1]);
  });

  it('hangs the plates down the wall with the top picture turned a quarter so it still reads upright', () => {
    for (const sliceAxis of ['length', 'width']) {
      const across = mountFrame(values({ mount: 'wall', sliceAxis }));
      const v = values({ mount: 'wall', sliceAxis, wallPlates: 'down' });
      const f = mountFrame(v);
      // up is now across the plates (the picture's old right), so each plate hangs straight down
      close(f.up, across.right);
      close(cross(f.up, f.toward), f.right);
      // the picture takes a quarter turn: topUV puts its top on the old right, its right at the front end
      expect(Number(v.topRotate)).toBe(90);
      close(f.right, across.up.map((x) => -x));
    }
    expect(Number(values({ mount: 'wall', wallPlates: 'down', topRotate: '270' }).topRotate)).toBe(0);
    // only with the top picture at the top, and never on a table
    expect(Number(values({ wallPlates: 'down' }).topRotate)).toBe(0);
    expect(Number(values({ mount: 'wall', wallTop: 'left', wallPlates: 'down' }).topRotate)).toBe(0);
    // keyholes follow: the old right side is now the top edge
    expect(wallTopEdge(values({ mount: 'wall', wallPlates: 'down' }))).toBe('right');
  });

  it('names its top edge the way Steel base › Edge does', () => {
    for (const e of ['back', 'front', 'left', 'right']) expect(wallTopEdge(values({ mount: 'wall', wallTop: e }))).toBe(e);
    expect(wallTopEdge(values({ mount: 'wall' }))).toBe('back');
  });
});

describe('sun', () => {
  it('is exactly the old sun for a table piece', () => {
    for (const sliceAxis of ['length', 'width']) {
      const v = values({ sliceAxis, sunFacing: '137' });
      for (const az of [0, 45, 133, 270, 359]) {
        const [hx, hz] = bearingToWorld(v, az);
        close(bearingDir(v, az), [hx, 0, hz]);
        for (const el of [3, 30, 70]) close(sunDir(v, az, el), sunVector(v, { azimuth: az, elevation: el } as never));
      }
    }
  });

  it('lights a south-facing wall piece from the front at noon, and not from behind', () => {
    const v = values({ mount: 'wall', sunFacing: '180' });
    const f = mountFrame(v);
    const noon = sunDir(v, 180, 40);
    expect(modelToRoom(f, noon)[2]).toBeGreaterThan(0.7);
    expect(modelToRoom(f, noon)[1]).toBeCloseTo(Math.sin((40 * Math.PI) / 180), 9);
    expect(sunBehindWall(v, noon)).toBe(false);
    expect(sunBehindWall(v, sunDir(v, 0, 20))).toBe(true);
    expect(sunBehindWall(values(), sunDir(values(), 0, 20))).toBe(false);
  });
});

describe('wall checks', () => {
  const steel = { mount: 'wall', baseMaterial: 'steel', steelHoles: 'edge', steelHoleStyle: 'keyhole' };
  const texts = (v: Values, has = {}) => mountIssues(v, has).map((i) => i.message);

  it('says nothing for a table piece', () => {
    expect(mountIssues(values({ ...steel, mount: 'table', steelHoleSide: 'front' }), { candles: true })).toEqual([]);
    expect(mountWeightIssue(values(), 80)).toBeNull();
  });

  it('wants keyholes pointing at the top edge, and some way to hang it', () => {
    expect(texts(values({ ...steel, steelHoleSide: 'back' }))).toEqual([]);
    expect(texts(values({ ...steel, steelHoleSide: 'front' })).join()).toMatch(/Set Steel base › Edge to Back end/);
    expect(texts(values({ ...steel, wallTop: 'left', steelHoleSide: 'back' })).join()).toMatch(/Edge to Left side/);
    expect(texts(values({ ...steel, steelHoles: '0' })).join()).toMatch(/no fixing holes/);
    expect(texts(values({ mount: 'wall' })).join()).toMatch(/concrete base/);
  });

  it('explains wall candles, flags shadow pictures and heavy pieces', () => {
    expect(texts(values({ ...steel, steelHoleSide: 'back' }), { candles: true }).join()).toMatch(/each candle stands upright on the plate below it/);
    expect(texts(values({ ...steel, steelHoleSide: 'back', shadowOn: 'true' })).join()).toMatch(/Shadow pictures/);
    expect(texts(values({ ...steel, wallPlates: 'down', steelHoleSide: 'right' }), { map: true }).join()).toMatch(/Set Plates run to Across/);
    expect(texts(values({ ...steel, wallPlates: 'down', steelHoleSide: 'right' })).join()).toBe('');
    expect(mountWeightIssue(values({ mount: 'wall' }), 40)?.message).toMatch(/40 kg/);
    expect(mountWeightIssue(values({ mount: 'wall' }), 4)).toBeNull();
  });
});

describe('hero render of a wall piece', () => {
  const FIXTURE = 'test/fixtures/projects/lucky-horseshoe.strata.json';

  it('turns the piece into the room, adds its wall, and keeps the table piece as it was', async () => {
    // without its candles: on a wall they stand in cups rather than on fins, so the parts differ
    const table = { ...deserialize(readFileSync(FIXTURE, 'utf8')), candles: undefined };
    const wall = { ...deserialize(readFileSync(FIXTURE, 'utf8')), candles: undefined };
    wall.params = { ...wall.params, mount: 'wall' };
    const mt = createPipeline()(table, await loadAssets(table));
    const mw = createPipeline()(wall, await loadAssets(wall));
    expect(mw.sliced.parts.length).toBe(mt.sliced.parts.length);
    const st = heroScene(mt, table);
    const sw = heroScene(mw, wall);
    expect(st.room).toBeUndefined();
    expect(st.meshes.some((m) => m.kind === 'wall')).toBe(false);
    const w = sw.meshes.find((m) => m.kind === 'wall');
    expect(w).toBeTruthy();
    // the base's underside is on the wall (room z = 0) and everything else stands out from it
    expect(sw.min[2]).toBeCloseTo(0, 4);
    w!.geometry.computeBoundingBox();
    expect(w!.geometry.boundingBox!.max.z).toBeLessThanOrEqual(0);
    // the piece is as tall on the wall as the table piece is deep (the length runs up it)
    expect(sw.max[1] - sw.min[1]).toBeCloseTo(st.max[0] - st.min[0], 4);
    expect(sw.max[2] - sw.min[2]).toBeCloseTo(st.max[1] - st.min[1], 4);
    // a camera from the 3D view (model coordinates) is turned with it; up comes out level
    const cam = defaultHeroCamera(sw);
    const glb = heroGlb(sw, cam);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
    const node = json.nodes.find((n: { name: string }) => n.name === 'camera');
    expect(node.translation[2]).toBeGreaterThan(sw.max[2]);
    expect(node.translation[1]).toBeGreaterThan((sw.min[1] + sw.max[1]) / 2);
  });
});

describe('building on a wall', () => {
  const FIXTURE = 'test/fixtures/projects/lucky-horseshoe.strata.json';

  it('stands candles upright in the room, each on the plate below it, with a chimney above', async () => {
    const wall = deserialize(readFileSync(FIXTURE, 'utf8'));
    wall.params = { ...wall.params, mount: 'wall' };
    const table = deserialize(readFileSync(FIXTURE, 'utf8'));
    const m = createPipeline()(wall, await loadAssets(wall));
    const mt = createPipeline()(table, await loadAssets(table));
    expect(m.sliced.plates.length).toBe(mt.sliced.plates.length);
    const f = mountFrame(m.v);
    const candles = m.objects.filter((b) => b.object.id.startsWith('candle')).map((b) => b.object);
    expect(candles.length).toBe(7);
    // plate top faces along up (the plates lie level on this wall: picture top is up)
    const faces = m.sliced.parts.filter((p) => p.family === 'P').map((p) => p.plane.origin[0] * f.up[0] + p.plane.origin[1] * f.up[1] + p.plane.origin[2] * f.up[2] + p.thickness / 2);
    for (const c of candles) {
      expect(c.holder).toBeUndefined();
      const axis = new (await import('three')).Vector3(0, 1, 0).applyMatrix4(objectMatrix(c)).sub(new (await import('three')).Vector3().applyMatrix4(objectMatrix(c)));
      close(axis.toArray(), f.up);
      const bottom = c.x * f.up[0] + c.y * f.up[1] + c.z * f.up[2] - c.h / 2;
      expect(faces.some((h) => Math.abs(h - bottom) < 1e-6)).toBe(true);
      expect(m.objects.some((b) => b.object.id === `flame${c.id.slice(6)}` && b.object.look === 'hidden')).toBe(true);
    }
    // no fins, wells or pads on a wall
    expect(m.sliced.parts.some((p) => p.family === 'K')).toBe(false);
    expect(m.objects.some((b) => /^(well|pad)\d/.test(b.object.id))).toBe(false);
  });

  it('with the plates hanging down the wall, candles stand along the plates and the plate count holds', async () => {
    const wall = deserialize(readFileSync(FIXTURE, 'utf8'));
    wall.params = { ...wall.params, mount: 'wall' };
    const table = deserialize(readFileSync(FIXTURE, 'utf8'));
    // one pipeline, switched from across to down as in the app, so nothing stale is kept
    const run = createPipeline();
    run(wall, await loadAssets(wall));
    wall.params = { ...wall.params, wallPlates: 'down' };
    const m = run(wall, await loadAssets(wall));
    const mt = createPipeline()(table, await loadAssets(table));
    expect(m.sliced.plates.length).toBe(mt.sliced.plates.length);
    const f = mountFrame(m.v);
    // the plates hang: their faces are upright in the room
    for (const p of m.sliced.parts.filter((q) => q.family === 'P')) expect(Math.abs(p.plane.normal[0] * f.up[0] + p.plane.normal[1] * f.up[1] + p.plane.normal[2] * f.up[2])).toBeLessThan(1e-6);
    const T = await import('three');
    // the plates' top ends, along up
    const top = Math.max(...m.sliced.parts.filter((q) => q.family === 'P').flatMap((q) => q.shape.flatMap((e) => e.outer.map(([a, b]) => [0, 1, 2].reduce((t, i) => t + (q.plane.origin[i] + q.plane.u[i] * a + q.plane.v[i] * b) * f.up[i], 0)))));
    for (const c of m.objects.filter((b) => b.object.id.startsWith('candle')).map((b) => b.object)) {
      const axis = new T.Vector3(0, 1, 0).applyMatrix4(objectMatrix(c)).sub(new T.Vector3().applyMatrix4(objectMatrix(c)));
      close(axis.toArray(), f.up);
      // held in the seat it notches into the hanging plates, not pushed up off the top
      const bottom = c.x * f.up[0] + c.y * f.up[1] + c.z * f.up[2] - c.h / 2;
      expect(bottom).toBeLessThan(top - 1);
    }
  });

  it('keeps placed objects where they are on the piece, stood upright in the room', async () => {
    const wall = deserialize(readFileSync(FIXTURE, 'utf8'));
    wall.params = { ...wall.params, mount: 'wall' };
    wall.candles = undefined;
    wall.objects = [{ id: 'o1', name: 'Box', kind: 'box', w: 10, h: 20, d: 10, x: 5, y: 7, z: 40, rx: 0, ry: 0, rz: 0, clearance: 0.5, on: true }];
    const m = createPipeline()(wall, await loadAssets(wall));
    const f = mountFrame(m.v);
    const o = m.objects.find((b) => b.object.id === 'o1')!.object;
    // same spot on the piece as on the table
    close([o.x, o.y, o.z], [5, 7, 40]);
    // and its height (h) runs up the wall
    const g = m.objects.find((b) => b.object.id === 'o1')!.geometry;
    g.computeBoundingBox();
    const size = g.boundingBox!.getSize(new (await import('three')).Vector3()).toArray() as V3;
    expect(Math.abs(size[0] * f.up[0] + size[1] * f.up[1] + size[2] * f.up[2])).toBeCloseTo(20, 4);
  });
});
