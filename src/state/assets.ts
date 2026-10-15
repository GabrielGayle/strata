// Decode project assets (images, imported meshes) into the forms the pipeline uses.
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { decodeImage, type Gray } from '../core/image';
import { prepareMesh } from '../core/forms';
import { mergeGeometries } from '../core/geometry3d';
import type { Assets } from '../core/pipeline';
import type { ImageAsset, MeshAsset, Project } from '../core/project';
import { depthToGray, type DepthData } from '../core/depth';

const imgCache = new Map<string, Gray>();
const meshCache = new Map<string, THREE.BufferGeometry>();
// full-precision grid straight from the depth data (not the 8-bit picture), per settings object
const depthCache = new WeakMap<DepthData, Gray>();

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function parseMesh(asset: MeshAsset): THREE.BufferGeometry {
  const bytes = base64ToBytes(asset.data);
  let geo: THREE.BufferGeometry;
  if (asset.format === 'stl') {
    geo = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } else {
    const group = new OBJLoader().parse(new TextDecoder().decode(bytes));
    const geos: THREE.BufferGeometry[] = [];
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) geos.push((m.geometry as THREE.BufferGeometry).clone().applyMatrix4(m.matrixWorld));
    });
    if (!geos.length) throw new Error('OBJ has no meshes');
    geo = mergeGeometries(geos);
  }
  if (!geo.getAttribute('position')?.count) throw new Error('Mesh is empty');
  return prepareMesh(geo);
}

export function useAssets(project: Project): Assets {
  const [assets, setAssets] = useState<Assets>({ sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
  const side = project.images.side;
  const front = project.images.front;
  const top = project.images.top;
  const sideKey = side?.depth ?? side?.dataUrl;
  const frontKey = front?.depth ?? front?.dataUrl;
  const topKey = top?.depth ?? top?.dataUrl;
  const insData = project.meshes.ins;
  const srcData = project.meshes.src;
  useEffect(() => {
    let alive = true;
    (async () => {
      const img = async (a?: ImageAsset) => {
        if (a?.depth) {
          if (!depthCache.has(a.depth)) {
            try {
              depthCache.set(a.depth, depthToGray(a.depth));
            } catch {
              return null;
            }
          }
          return depthCache.get(a.depth)!;
        }
        const url = a?.dataUrl;
        if (!url) return null;
        if (!imgCache.has(url)) {
          try {
            imgCache.set(url, await decodeImage(url));
          } catch {
            return null;
          }
        }
        return imgCache.get(url)!;
      };
      const mesh = (a?: MeshAsset) => {
        if (!a) return null;
        const key = a.data.length + ':' + a.data.slice(0, 64) + a.data.slice(-64);
        if (!meshCache.has(key)) {
          try {
            meshCache.set(key, parseMesh(a));
          } catch {
            return null;
          }
        }
        return meshCache.get(key)!;
      };
      const next: Assets = { sideImg: await img(side), frontImg: await img(front), topImg: await img(top), insMesh: mesh(insData), srcMesh: mesh(srcData) };
      if (alive)
        setAssets((prev) =>
          prev.sideImg === next.sideImg && prev.frontImg === next.frontImg && prev.topImg === next.topImg && prev.insMesh === next.insMesh && prev.srcMesh === next.srcMesh ? prev : next,
        );
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideKey, frontKey, topKey, insData, srcData]);
  return assets;
}
