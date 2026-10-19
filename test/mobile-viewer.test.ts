import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { isViewerPath, phoneRedirect } from '../src/ui/mobile/route';
import { arSizeMm, buildArScene, exportUsdz } from '../src/ui/mobile/arExport';

describe('phone viewer route', () => {
  it('knows its own address', () => {
    expect(isViewerPath('/m')).toBe(true);
    expect(isViewerPath('/m/')).toBe(true);
    expect(isViewerPath('/')).toBe(false);
    expect(isViewerPath('/map')).toBe(false);
  });
  it('sends phones from the editor to the viewer, unless they chose the editor or followed a share link', () => {
    const at = (pathname: string, hash = '', search = '') => ({ pathname, hash, search });
    expect(phoneRedirect(at('/'), true, false)).toBe('/m');
    expect(phoneRedirect(at('/'), false, false)).toBeNull();
    expect(phoneRedirect(at('/'), true, true)).toBeNull();
    expect(phoneRedirect(at('/', '#s=abc'), true, false)).toBeNull();
    expect(phoneRedirect(at('/m'), true, false)).toBeNull();
  });
});

describe('AR export', () => {
  const sculpture = () => {
    const root = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: '#7a3b1e', metalness: 0.8, roughness: 0.5 });
    // a 300 × 200 × 10 mm plate standing on a 400 × 50 × 100 mm base, all in mm, off centre
    const plate = new THREE.Mesh(new THREE.BoxGeometry(300, 200, 10), steel);
    plate.position.set(500, 150, 20);
    const base = new THREE.Mesh(new THREE.BoxGeometry(400, 50, 100), new THREE.MeshStandardMaterial({ color: '#fff', roughness: 0.9 }));
    base.position.set(500, 25, 20);
    // things that must stay out: a grid, a label, a wireframe ghost, a hidden part
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.ShaderMaterial());
    const label = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
    const ghost = new THREE.Mesh(new THREE.BoxGeometry(900, 900, 900), new THREE.MeshStandardMaterial({ wireframe: true }));
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(2000, 2000, 2000), steel);
    hidden.visible = false;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(3000, 0, 0)]));
    root.add(plate, base, grid, label, ghost, hidden, line);
    return root;
  };

  it('keeps only the solid parts, in metres, centred and standing on the floor', () => {
    const scene = buildArScene(sculpture());
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    expect(meshes).toHaveLength(2);
    const box = new THREE.Box3().setFromObject(scene);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(0.25, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 6);
    const size = arSizeMm(scene);
    expect(size.x).toBeCloseTo(400, 3);
    expect(size.y).toBeCloseTo(250, 3);
    expect(size.z).toBeCloseTo(100, 3);
  });

  it('copies instanced parts (rods, nuts) one by one', () => {
    const root = new THREE.Group();
    const rods = new THREE.InstancedMesh(new THREE.CylinderGeometry(5, 5, 100), new THREE.MeshStandardMaterial(), 3);
    for (let i = 0; i < 3; i++) rods.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 100, 50, 0));
    root.add(rods);
    const scene = buildArScene(root);
    let n = 0;
    scene.traverse((o) => (o as THREE.Mesh).isMesh && n++);
    expect(n).toBe(3);
    expect(arSizeMm(scene).x).toBeCloseTo(210, 3);
  });

  it('writes a USDZ Quick Look can place on a table', async () => {
    const bytes = await exportUsdz(buildArScene(sculpture()));
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    expect(names[0]).toBe('model.usda');
    const usda = strFromU8(files['model.usda']);
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('preliminary:anchoring:type = "plane"');
    expect(usda).toContain('preliminary:planeAnchoring:alignment = "horizontal"');
    expect(names.filter((n) => n.startsWith('geometries/'))).toHaveLength(2);
  });

  it('has nothing to place when nothing is solid', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()));
    expect(buildArScene(root).children).toHaveLength(0);
  });
});
