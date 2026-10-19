// Augmented reality on iPhone: Safari has no WebXR, so the 3D view is written
// as a USDZ file and opened with Apple's AR Quick Look (an <a rel="ar"> link).
// Only the solid parts go in: plates, concrete, rods, objects. Grids, labels,
// outlines and helpers stay behind. Strata works in millimetres; USDZ in metres,
// so the copy is scaled to true size, centred, and stood on the floor (y = 0).
import * as THREE from 'three';

/** Plain concrete grey for the banded pour shader, which Quick Look can't run. */
const CONCRETE = '#b8b4ab';

function solidLook(m: THREE.Material): THREE.MeshStandardMaterial | null {
  const any = m as THREE.Material & {
    color?: THREE.Color;
    metalness?: number;
    roughness?: number;
    wireframe?: boolean;
    setBands?: unknown;
  };
  if (!any.visible || any.wireframe || !any.color) return null;
  if (m.transparent && m.opacity < 0.35) return null;
  if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial && !(m as THREE.MeshPhongMaterial).isMeshPhongMaterial) return null;
  return new THREE.MeshStandardMaterial({
    color: any.setBands ? new THREE.Color(CONCRETE) : any.color.clone(),
    metalness: any.metalness ?? 0,
    roughness: any.roughness ?? 0.8,
    transparent: m.transparent && m.opacity < 1,
    opacity: m.opacity,
    side: THREE.DoubleSide,
  });
}

function usableGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const pos = g.getAttribute('position');
  if (!pos || pos.count < 3) return null;
  // the exporter wants plain (non-interleaved) position + normal; uvs are optional
  const out = new THREE.BufferGeometry();
  const plain = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) =>
    (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).clone() : (a as THREE.BufferAttribute).clone();
  out.setAttribute('position', plain(pos));
  const n = g.getAttribute('normal');
  if (n) out.setAttribute('normal', plain(n));
  const uv = g.getAttribute('uv');
  if (uv) out.setAttribute('uv', plain(uv));
  if (g.index) out.setIndex(g.index.clone());
  if (!n) out.computeVertexNormals();
  return out;
}

/**
 * A clean copy of `root`'s solid meshes, in metres, centred over the origin with
 * its lowest point on the floor. Empty when there is nothing solid to show.
 */
export function buildArScene(root: THREE.Object3D, mmPerUnit = 1): THREE.Scene {
  root.updateWorldMatrix(true, true);
  const parts = new THREE.Group();
  const geoCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry | null>();
  const matCache = new Map<THREE.Material, THREE.MeshStandardMaterial | null>();
  const geoOf = (g: THREE.BufferGeometry) => {
    if (!geoCache.has(g)) geoCache.set(g, usableGeometry(g));
    return geoCache.get(g)!;
  };
  const matOf = (m: THREE.Material) => {
    if (!matCache.has(m)) matCache.set(m, solidLook(m));
    return matCache.get(m)!;
  };
  const visible = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (!p.visible) return false;
      if (p === root) return true;
    }
    return true;
  };
  const tmp = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !visible(mesh)) return;
    if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as unknown as THREE.Sprite).isSprite) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!material) return;
    const mat = matOf(material);
    const geo = geoOf(mesh.geometry);
    if (!mat || !geo) return;
    const inst = o as THREE.InstancedMesh;
    const copies = inst.isInstancedMesh ? inst.count : 1;
    for (let i = 0; i < copies; i++) {
      const copy = new THREE.Mesh(geo, mat);
      copy.matrixAutoUpdate = false;
      if (inst.isInstancedMesh) {
        inst.getMatrixAt(i, tmp);
        copy.matrix.multiplyMatrices(mesh.matrixWorld, tmp);
      } else copy.matrix.copy(mesh.matrixWorld);
      copy.matrix.decompose(copy.position, copy.quaternion, copy.scale);
      copy.matrixAutoUpdate = true;
      parts.add(copy);
    }
  });
  const scene = new THREE.Scene();
  if (!parts.children.length) return scene;
  const box = new THREE.Box3().setFromObject(parts);
  const centre = box.getCenter(new THREE.Vector3());
  const k = mmPerUnit / 1000;
  const holder = new THREE.Group();
  holder.scale.setScalar(k);
  parts.position.set(-centre.x, -box.min.y, -centre.z);
  holder.add(parts);
  scene.add(holder);
  scene.updateMatrixWorld(true);
  return scene;
}

/** The size of what goes into AR, in millimetres (for the label next to the button). */
export function arSizeMm(scene: THREE.Scene): { x: number; y: number; z: number } {
  const b = new THREE.Box3().setFromObject(scene);
  const s = b.getSize(new THREE.Vector3()).multiplyScalar(1000);
  return { x: s.x, y: s.y, z: s.z };
}

/** USDZ bytes for Quick Look: placed on a floor or table, at true size. */
export async function exportUsdz(scene: THREE.Scene): Promise<Uint8Array> {
  const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
  const exporter = new USDZExporter();
  const out = await exporter.parseAsync(scene, {
    quickLookCompatible: true,
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
  });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

/** Safari on iPhone and iPad opens <a rel="ar"> links in AR Quick Look. */
export function canQuickLook(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  try {
    return !!doc?.createElement('a').relList?.supports?.('ar');
  } catch {
    return false;
  }
}

