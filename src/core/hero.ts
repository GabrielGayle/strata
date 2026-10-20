// Hero renders (Boost): the finished piece as a photograph, rendered with Blender
// Cycles on the cloud from `model.glb`. This file makes that GLB from the model, so
// the browser, the CLI and the cloud worker write the same bytes from the same design,
// and decides whether a saved render still shows the design (its fingerprint).
//
// The GLB is plain glTF 2.0 in metres, y up: one mesh per look (each plate metal and
// finish, the concrete, candles, cards), each material named "strata:<kind>" with the
// look in its extras for the Blender script (worker/hero_render.py). The camera is a
// glTF camera node; candle flames are empty nodes named "flame".
import * as THREE from 'three';
import { bucketOf, lookOf, type Look } from './appearance';
import { baseGeometry } from './base';
import { extrudeOnPlane, extrudeSunkenFrame, mergeGeometries } from './geometry3d';
import type { Model } from './pipeline';
import { objectMatrix } from './objects';
import type { Project } from './project';
import { Hash128 } from './resultCache';
import type { SavedHero } from './heroSaved';
import { mountFrame, modelToRoomMatrix } from './mount';
import { isMapDepth } from './mapPlateHeight';

export { cleanSavedHero, HERO_LIGHTS, type HeroLight, type SavedHero } from './heroSaved';

/** A camera in the 3D view's world (millimetres, y up). */
export interface HeroCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view, degrees. */
  fov: number;
  /** Width over height of the picture. */
  aspect: number;
}

/** What a hero mesh is made of, for Blender's materials. */
export type HeroKind = 'plate' | 'concrete' | 'insert-metal' | 'rod' | 'wax' | 'cup' | 'card' | 'wall';

export interface HeroMesh {
  name: string;
  kind: HeroKind;
  look: Look;
  /** Plates: the metal and finish ids, so Blender can add rust or brushing. */
  metal?: string;
  finish?: string;
  /** Concrete: the pour bands, bottom to top, in metres from the floor. */
  bands?: { y0: number; y1: number; color: string }[];
  geometry: THREE.BufferGeometry;
}

export interface HeroScene {
  meshes: HeroMesh[];
  /** Candle flames: centre and height, metres. */
  flames: { p: [number, number, number]; size: number }[];
  /** Bounds of the solid parts, metres. */
  min: [number, number, number];
  max: [number, number, number];
  /** Plates in the model, which the worker reports back and the app checks. */
  plates: number;
  parts: number;
  /**
   * Wall pieces: the column-major matrix that turned the model into the room (y up).
   * The meshes are already turned; a camera from the 3D view (model coordinates) is
   * turned with it when the GLB is written.
   */
  room?: number[];
}

const MM = 0.001;

const LOOKS: Record<Exclude<HeroKind, 'plate' | 'concrete'>, Look> = {
  'insert-metal': { color: '#5f666b', metalness: 0.85, roughness: 0.42 },
  rod: { color: '#d4dbe2', metalness: 0.75, roughness: 0.28 },
  wax: { color: '#f1e8d6', metalness: 0, roughness: 0.6 },
  cup: { color: '#c9ccd1', metalness: 0.85, roughness: 0.35 },
  card: { color: '#f3eee2', metalness: 0, roughness: 0.85 },
  wall: { color: '#ece8e1', metalness: 0, roughness: 0.95 },
};

function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  if (g.getAttribute('normal')) out.setAttribute('normal', g.getAttribute('normal'));
  if (g.index) out.setIndex(g.index);
  return out;
}

/**
 * Copies of a triangle soup's positions and normals with every triangle wound to face its
 * normals. Some plate meshes come out wound clockwise; three draws them double-sided, but
 * Cycles reads the winding as the outside and renders them black.
 */
export function windOutward(pos: Float32Array, nor: Float32Array): [Float32Array, Float32Array] {
  const p = new Float32Array(pos);
  const n = new Float32Array(nor);
  for (let t = 0; t + 9 <= p.length; t += 9) {
    const ux = p[t + 3] - p[t], uy = p[t + 4] - p[t + 1], uz = p[t + 5] - p[t + 2];
    const vx = p[t + 6] - p[t], vy = p[t + 7] - p[t + 1], vz = p[t + 8] - p[t + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const dot = cx * (n[t] + n[t + 3] + n[t + 6]) + cy * (n[t + 1] + n[t + 4] + n[t + 7]) + cz * (n[t + 2] + n[t + 5] + n[t + 8]);
    if (dot >= 0) continue;
    for (const a of [p, n]) {
      for (let k = 0; k < 3; k++) {
        const b = a[t + 3 + k];
        a[t + 3 + k] = a[t + 6 + k];
        a[t + 6 + k] = b;
      }
    }
  }
  return [p, n];
}

/** The solid parts of the model, grouped by look. Same design, same meshes. */
export function heroScene(model: Model, project: Project): HeroScene {
  const v = model.v;
  const main = String(v.plateMaterial);
  const byLook = new Map<string, { mesh: Omit<HeroMesh, 'geometry'>; geos: THREE.BufferGeometry[] }>();
  const add = (key: string, mesh: Omit<HeroMesh, 'geometry'>, g: THREE.BufferGeometry) => {
    let e = byLook.get(key);
    if (!e) byLook.set(key, (e = { mesh, geos: [] }));
    e.geos.push(g);
  };
  for (const p of model.sliced.parts) {
    const b = bucketOf(project.appearance, p.plateKey);
    const metal = b?.material ?? main;
    const finish = b ? b.finish : project.appearance?.main?.finish;
    const color = b ? b.color : project.appearance?.main?.color;
    const look = lookOf(metal, finish, color);
    const key = `plate:${metal}:${finish ?? ''}:${look.color}`;
    add(key, { name: `plates ${metal}${finish ? ` ${finish}` : ''}`, kind: 'plate', look, metal, finish: finish ?? undefined }, extrudeOnPlane(p.shape, p.thickness, p.plane));
  }
  const bands = model.pour.rows.map((r) => ({ y0: r.y0 * MM, y1: r.y1 * MM, color: r.color }));
  const concrete: Look = { color: bands[0]?.color ?? '#b8b4ab', metalness: 0, roughness: 0.92 };
  if (model.sunkenFrame) add('concrete', { name: 'concrete', kind: 'concrete', look: concrete, bands }, extrudeSunkenFrame(model.sunkenFrame));
  else if (v.baseOn) add('concrete', { name: 'concrete', kind: 'concrete', look: concrete, bands }, baseGeometry(v, model.sliced.baseOutline));
  if (model.insert && v.insMaterial !== 'void') {
    const g = model.insert.form.geometry.clone();
    if (v.insMaterial === 'metal') add('insert-metal', { name: 'insert', kind: 'insert-metal', look: LOOKS['insert-metal'] }, g);
    else add('insert', { name: 'insert', kind: 'concrete', look: { color: String(v.insTint ?? '#6f6a64'), metalness: 0, roughness: 0.92 }, bands: [] }, g);
  }
  for (const r of model.sliced.stackRods?.rods ?? []) {
    const a = new THREE.Vector3(...r.a);
    const b = new THREE.Vector3(...r.b);
    const len = a.distanceTo(b) || r.length;
    const g = new THREE.CylinderGeometry(r.diameter / 2, r.diameter / 2, len, 16);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    add('rod', { name: 'rods', kind: 'rod', look: LOOKS.rod }, g);
  }
  const flames: HeroScene['flames'] = [];
  for (const { object: o, geometry } of model.objects) {
    if (o.look === 'hidden' || o.on === false) continue;
    if (o.look === 'candle' || o.look === 'tealight') {
      const kind = o.look === 'tealight' ? 'cup' : 'wax';
      add(kind, { name: o.look === 'tealight' ? 'tealight cups' : 'candles', kind, look: LOOKS[kind] }, geometry.clone());
      // in the candle's own frame, so wax and flame stand up the way it does
      const pose = objectMatrix(o);
      if (kind === 'cup') {
        // the wax in the cup, as the 3D view draws it
        const disc = new THREE.CircleGeometry(Math.max(0.5, o.w / 2 - 1), 40);
        disc.rotateX(-Math.PI / 2);
        disc.translate(0, o.h / 2 + 0.01, 0);
        disc.applyMatrix4(pose);
        add('wax', { name: 'candles', kind: 'wax', look: LOOKS.wax }, disc);
      }
      const flame = Math.min(22, Math.max(9, o.w * 0.45));
      const fp = new THREE.Vector3(0, o.h / 2 + 5 + flame / 2, 0).applyMatrix4(pose);
      flames.push({ p: [fp.x * MM, fp.y * MM, fp.z * MM], size: flame * MM });
    } else if (o.kind === 'card') {
      add('card', { name: 'cards', kind: 'card', look: LOOKS.card }, geometry.clone());
    }
  }
  const meshes: HeroMesh[] = [];
  const box = new THREE.Box3();
  // a wall piece is turned into the room (its base flat on the wall) before it goes to Blender
  const frame = mountFrame(v, isMapDepth(project.images.top?.depth) && !!project.images.top?.map);
  const room = frame.mount === 'wall' ? new THREE.Matrix4().fromArray(modelToRoomMatrix(frame)) : null;
  for (const { mesh, geos } of byLook.values()) {
    const g = mergeGeometries(geos.map(plain));
    if (room) g.applyMatrix4(room);
    g.scale(MM, MM, MM);
    g.computeBoundingBox();
    box.union(g.boundingBox!);
    meshes.push({ ...mesh, geometry: g });
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
  if (room) {
    for (const fl of flames) fl.p = new THREE.Vector3(...fl.p).applyMatrix4(room).toArray() as [number, number, number];
    // the wall: the underside of the base sits on it (room z = 0); it reaches well past the
    // piece and down towards the floor, which Blender lays at its foot
    const size = box.getSize(new THREE.Vector3());
    const reach = Math.max(size.x, size.y, 0.3);
    const w = size.x + reach * 2.4;
    const h = size.y + reach * 1.2 + 0.9;
    const g = new THREE.BoxGeometry(w, h, 0.02).toNonIndexed();
    g.translate((box.min.x + box.max.x) / 2, box.max.y + reach * 1.2 - h / 2, -0.0105);
    meshes.push({ name: 'wall', kind: 'wall', look: LOOKS.wall, geometry: plain(g) });
  }
  return {
    meshes,
    flames,
    min: box.min.toArray() as [number, number, number],
    max: box.max.toArray() as [number, number, number],
    plates: model.sliced.plates.length,
    parts: model.sliced.parts.length,
    ...(room ? { room: modelToRoomMatrix(frame) } : {}),
  };
}

/** 32 hex characters naming what the render would show: the meshes, their looks and the flames. */
export function heroFingerprintOf(scene: HeroScene): string {
  const h = new Hash128();
  h.str('hero:v1');
  for (const m of scene.meshes) {
    h.str(`${m.kind}|${m.name}|${m.look.color}|${m.look.metalness}|${m.look.roughness}|${m.metal ?? ''}|${m.finish ?? ''}|${JSON.stringify(m.bands ?? [])}`);
    h.bytes(m.geometry.getAttribute('position').array as Float32Array);
  }
  // flames are doubles worked out with trig, whose last digit differs between the browser and
  // the cloud's Node: a micrometre is plenty to say they stand in the same place
  h.str(JSON.stringify(scene.flames.length ? scene.flames.map((f) => ({ p: f.p.map(r6), size: r6(f.size) })) : scene.flames));
  return h.digest();
}

const fingerprints = new WeakMap<Model, { appearance: Project['appearance']; fp: string }>();

/** The fingerprint of what a render of this model would show (kept per model: the pack asks three times). */
export function heroFingerprint(model: Model, project: Project): string {
  const hit = fingerprints.get(model);
  if (hit && hit.appearance === project.appearance) return hit.fp;
  const fp = heroFingerprintOf(heroScene(model, project));
  fingerprints.set(model, { appearance: project.appearance, fp });
  return fp;
}

/** The project's render when it still shows this design, else undefined. */
export function currentHero(project: Project, model: Model): SavedHero | undefined {
  const hero = project.hero;
  if (!hero) return undefined;
  return heroFingerprint(model, project) === hero.fingerprint ? hero : undefined;
}

/** The PNG bytes of a saved render. */
export function heroPngBytes(hero: SavedHero): Uint8Array {
  const b64 = hero.png.slice(hero.png.indexOf(',') + 1);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The 3D view's opening Iso camera, for renders made without the app (the CLI). */
export function defaultHeroCamera(scene: HeroScene): HeroCamera {
  const min = new THREE.Vector3(...scene.min).multiplyScalar(1 / MM);
  const max = new THREE.Vector3(...scene.max).multiplyScalar(1 / MM);
  const centre = min.clone().add(max).multiplyScalar(0.5);
  const size = Math.max(1, max.clone().sub(min).length());
  const fov = 32;
  const dist = (size * 0.62) / Math.tan(((fov / 2) * Math.PI) / 180);
  const pos = centre.clone().add(new THREE.Vector3(0.95, 0.75, 1.25).normalize().multiplyScalar(dist));
  const up = new THREE.Vector3(0, 1, 0);
  // the bounds are in the room; heroGlb takes a camera in the model's coordinates
  if (scene.room) {
    const back = new THREE.Matrix4().fromArray(scene.room).invert();
    pos.applyMatrix4(back);
    centre.applyMatrix4(back);
    up.transformDirection(back);
  }
  return { position: pos.toArray() as [number, number, number], target: centre.toArray() as [number, number, number], up: up.toArray() as [number, number, number], fov, aspect: 3 / 2 };
}

// ---- GLB writer ----------------------------------------------------------------

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearColor(hex: string): [number, number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255), 1];
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * The scene as a binary glTF, with the camera when given. Deterministic: the same scene
 * and camera give the same bytes.
 */
export function heroGlb(scene: HeroScene, camera?: HeroCamera): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const push = (data: ArrayBufferView, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    chunks.push(bytes);
    byteLength += bytes.length;
    return bufferViews.length - 1;
  };
  const meshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const m of scene.meshes) {
    const pos = m.geometry.getAttribute('position').array as Float32Array;
    const nor = m.geometry.getAttribute('normal').array as Float32Array;
    const count = pos.length / 3;
    if (!count) continue;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], pos[i + k]);
        hi[k] = Math.max(hi[k], pos[i + k]);
      }
    }
    const [p, n] = windOutward(pos, nor);
    const pa = accessors.push({ bufferView: push(p, 34962), componentType: 5126, count, type: 'VEC3', min: lo, max: hi }) - 1;
    const na = accessors.push({ bufferView: push(n, 34962), componentType: 5126, count, type: 'VEC3' }) - 1;
    const mat =
      materials.push({
        name: `strata:${m.kind}`,
        pbrMetallicRoughness: { baseColorFactor: linearColor(m.look.color).map(r6), metallicFactor: m.look.metalness, roughnessFactor: m.look.roughness },
        doubleSided: true,
        extras: { strata: m.kind, color: m.look.color, ...(m.metal ? { metal: m.metal } : {}), ...(m.finish ? { finish: m.finish } : {}), ...(m.bands ? { bands: m.bands.map((b) => ({ y0: r6(b.y0), y1: r6(b.y1), color: b.color })) } : {}) },
      }) - 1;
    meshes.push({ name: m.name, primitives: [{ attributes: { POSITION: pa, NORMAL: na }, material: mat, mode: 4 }] });
    nodes.push({ name: m.name, mesh: meshes.length - 1 });
  }
  scene.flames.forEach((f, i) => nodes.push({ name: `flame.${String(i + 1).padStart(3, '0')}`, translation: f.p.map(r6), extras: { strata: 'flame', size: r6(f.size) } }));
  const cameras: Record<string, unknown>[] = [];
  if (camera) {
    const room = scene.room ? new THREE.Matrix4().fromArray(scene.room) : null;
    const eye = new THREE.Vector3(...camera.position);
    const target = new THREE.Vector3(...camera.target);
    const up = new THREE.Vector3(...camera.up);
    if (room) {
      eye.applyMatrix4(room);
      target.applyMatrix4(room);
      up.transformDirection(room);
    }
    eye.multiplyScalar(MM);
    target.multiplyScalar(MM);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, target, up.normalize()));
    cameras.push({ type: 'perspective', perspective: { yfov: r6((camera.fov * Math.PI) / 180), aspectRatio: r6(camera.aspect), znear: 0.001 } });
    nodes.push({ name: 'camera', camera: 0, translation: eye.toArray().map(r6), rotation: q.toArray().map(r6), extras: { strata: 'camera', target: target.toArray().map(r6) } });
  }
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Strata hero' },
    scene: 0,
    scenes: [{ name: 'strata', nodes: nodes.map((_, i) => i), extras: { min: scene.min.map(r6), max: scene.max.map(r6), plates: scene.plates, parts: scene.parts, fingerprint: heroFingerprintOf(scene) } }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
    ...(cameras.length ? { cameras } : {}),
  };
  const binPad = (4 - (byteLength % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonLen = jsonBytes.length + jsonPad;
  const binLen = byteLength + binPad;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  let o = 20 + jsonLen;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true); // BIN
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---- what a render shows, written into the PNG ------------------------------------

/** Written into every hero PNG by the worker, so a render checks itself even from the cloud cache. */
export interface HeroStamp {
  fingerprint: string;
  plates: number;
  parts: number;
}

const STAMP_KEY = 'strata';

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const isPng = (b: Uint8Array) => b.length > 33 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** The PNG with a tEXt chunk "strata" holding the stamp, right after its header. */
export function stampHeroPng(png: Uint8Array, stamp: HeroStamp): Uint8Array {
  if (!isPng(png)) throw new Error('not a PNG');
  const text = new TextEncoder().encode(`${STAMP_KEY}\0${JSON.stringify(stamp)}`);
  const chunk = new Uint8Array(12 + text.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, text.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // tEXt
  chunk.set(text, 8);
  dv.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));
  // signature (8) + IHDR (4 + 4 + 13 + 4)
  const at = 33;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

/** The stamp in a hero PNG, its size, or undefined when it has none. */
export function readHeroPng(png: Uint8Array): (HeroStamp & { w: number; h: number }) | undefined {
  if (!isPng(png)) return undefined;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = dv.getUint32(16);
  const h = dv.getUint32(20);
  let o = 8;
  while (o + 12 <= png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tEXt') {
      const body = new TextDecoder().decode(png.subarray(o + 8, o + 8 + len));
      if (body.startsWith(`${STAMP_KEY}\0`)) {
        try {
          const s = JSON.parse(body.slice(STAMP_KEY.length + 1)) as HeroStamp;
          if (typeof s.fingerprint === 'string' && Number.isInteger(s.plates) && Number.isInteger(s.parts)) return { ...s, w, h };
        } catch {
          return undefined;
        }
      }
    }
    o += 12 + len;
  }
  return undefined;
}
