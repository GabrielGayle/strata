import * as THREE from 'three';

export interface Band {
  top: number; // world y of the band's upper boundary
  color: string;
}

const MAX_BANDS = 8;

/**
 * Concrete: MeshStandardMaterial with pour bands coloured by world height,
 * optional noisy band boundaries ("sanded back") and a fine aggregate speckle.
 */
export function makeConcreteMaterial(): THREE.MeshStandardMaterial & { setBands: (b: Band[], wobble: number) => void } {
  const uniforms = {
    uBands: { value: Array.from({ length: MAX_BANDS }, () => new THREE.Vector4(1e9, 0.6, 0.6, 0.6)) },
    uCount: { value: 1 },
    uWobble: { value: 0 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }) as THREE.MeshStandardMaterial & {
    setBands: (b: Band[], wobble: number) => void;
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos;
uniform vec4 uBands[${MAX_BANDS}];
uniform int uCount;
uniform float uWobble;
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 q = vWPos.xz + vec2(vWPos.y * 0.37, -vWPos.y * 0.21);
  float w = (sNoise(q * 0.015) * 0.65 + sNoise(q * 0.06) * 0.35 - 0.5) * 2.0;
  float y = vWPos.y + uWobble * w;
  vec3 c = uBands[0].yzw;
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= uCount) break;
    c = uBands[i].yzw;
    if (y < uBands[i].x) break;
  }
  float speck = sNoise(vWPos.xz * 0.9 + vWPos.y * 0.7) * 0.5 + sNoise(vWPos.zy * 1.7) * 0.5;
  c *= 0.9 + 0.12 * speck;
  diffuseColor.rgb = c;
}`,
      );
  };
  const col = new THREE.Color();
  mat.setBands = (bands, wobble) => {
    const n = Math.max(1, Math.min(MAX_BANDS, bands.length));
    for (let i = 0; i < MAX_BANDS; i++) {
      const b = bands[Math.min(i, bands.length - 1)];
      if (!b) continue;
      col.set(b.color).convertSRGBToLinear();
      uniforms.uBands.value[i].set(i === n - 1 ? 1e9 : b.top, col.r, col.g, col.b);
    }
    uniforms.uCount.value = n;
    uniforms.uWobble.value = wobble;
  };
  return mat;
}

export const METALS: Record<string, { color: string; metalness: number; roughness: number }> = {
  steel: { color: '#5f666b', metalness: 0.85, roughness: 0.42 },
  aluminium: { color: '#c3c7cb', metalness: 0.9, roughness: 0.3 },
  corten: { color: '#8b4a2a', metalness: 0.35, roughness: 0.82 },
};

export const PLY = '#d6b88a';
