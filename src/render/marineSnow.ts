/**
 * 水下悬浮颗粒（海雪）—— 水体流动感的视觉锚点。
 * 固定容量的微小粒子在水体范围内缓慢往复漂移；透明度绑定 underwaterBlend，
 * 水面上完全不可见。装饰性细节，不参与物理波形与仪器读数。
 */
import * as THREE from 'three';
import { PARTICLE_FRAG, PARTICLE_VERT } from './shaders';

export interface MarineSnow {
  points: THREE.Points;
  /** time = 波面仿真时间；blend = 水下过渡系数 [0,1] */
  update(time: number, blend: number, pixelScale: number): void;
  dispose(): void;
}

/** 粒子活动盒（以原点为中心）：收拢在相机常驻视野内保证密度 */
const BOX_XZ = 70;
const BOX_TOP = -0.5;
const BOX_BOTTOM = -30;

export function createMarineSnow(capacity = 600): MarineSnow {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const fades = new Float32Array(capacity);
  const sizes = new Float32Array(capacity);

  // 每粒固定基点与相位（容量固定，无运行期分配）
  const base = new Float32Array(capacity * 3);
  const seed = new Float32Array(capacity);
  for (let i = 0; i < capacity; i++) {
    base[i * 3] = (Math.random() * 2 - 1) * BOX_XZ;
    base[i * 3 + 1] = BOX_BOTTOM + Math.random() * (BOX_TOP - BOX_BOTTOM);
    base[i * 3 + 2] = (Math.random() * 2 - 1) * BOX_XZ;
    seed[i] = Math.random();
    fades[i] = 0.5 + Math.random() * 0.5;
    sizes[i] = 0.7 + Math.random() * 1.3;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fades, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setDrawRange(0, 0);

  // fog:true 材质必须自带 UniformsLib.fog（同 oceanSurface 的说明）
  const BASE_OPACITY = 0.75;
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTint: { value: new THREE.Color().setStyle('#bfe3da') },
    uOpacity: { value: 0 },
    uPixelScale: { value: 600 },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    update(time, blend, pixelScale) {
      if (blend < 0.02) {
        geometry.setDrawRange(0, 0);
        return;
      }
      for (let i = 0; i < capacity; i++) {
        const bx = base[i * 3] ?? 0;
        const by = base[i * 3 + 1] ?? 0;
        const bz = base[i * 3 + 2] ?? 0;
        const sd = seed[i] ?? 0;
        const t = time * 0.5 + sd * 100;
        // 缓慢往复漂移：水平双正弦 + 轻微垂向起伏（海雪的悬浮沉降观感）
        positions[i * 3] = bx + Math.sin(t * 0.13 + sd * 7) * 2.5 + Math.sin(t * 0.05) * 1.2;
        positions[i * 3 + 1] = by + Math.sin(t * 0.17 + sd * 3) * 1.1 - Math.sin(t * 0.061) * 0.8;
        positions[i * 3 + 2] = bz + Math.cos(t * 0.09 + sd * 5) * 2.5;
      }
      geometry.getAttribute('position').needsUpdate = true;
      geometry.setDrawRange(0, capacity);
      uniforms.uOpacity.value = BASE_OPACITY * Math.min(1, blend);
      uniforms.uPixelScale.value = pixelScale;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
