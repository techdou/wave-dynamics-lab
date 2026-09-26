/**
 * 浪花粒子渲染池（THREE.Points + 自定义点着色器）。
 * 纯逻辑的粒子池（logic/spawn.ts）每帧 sync 到这里；
 * 固定容量 BufferGeometry，drawRange 控制活跃数——无运行期分配。
 */
import * as THREE from 'three';
import { PARTICLE_FRAG, PARTICLE_VERT } from './shaders';
import type { SprayParticle } from './logic/spawn';
import { particleFade } from './logic/spawn';

export interface ParticleField {
  points: THREE.Points;
  /** 把池中活跃粒子写入顶点缓冲 */
  sync(pool: readonly SprayParticle[]): void;
  /** 视口高度变化或 fov 变化时更新点尺寸换算系数 */
  setPixelScale(scale: number): void;
  dispose(): void;
}

function linearColor(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex);
}

export function createParticleField(
  capacity: number,
  tintHex: string,
  opacity: number,
): ParticleField {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const fades = new Float32Array(capacity);
  const sizes = new Float32Array(capacity);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fades, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setDrawRange(0, 0);

  // fog:true 材质必须自带 UniformsLib.fog（同 oceanSurface 的说明）
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTint: { value: linearColor(tintHex) },
    uOpacity: { value: opacity },
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
    sync(pool) {
      let n = 0;
      for (const p of pool) {
        if (!p.active || n >= capacity) continue;
        positions[n * 3] = p.px;
        positions[n * 3 + 1] = p.py;
        positions[n * 3 + 2] = p.pz;
        fades[n] = particleFade(p);
        sizes[n] = p.size;
        n += 1;
      }
      geometry.setDrawRange(0, n);
      geometry.getAttribute('position').needsUpdate = true;
      geometry.getAttribute('aFade').needsUpdate = true;
      geometry.getAttribute('aSize').needsUpdate = true;
    },
    setPixelScale(scale) {
      uniforms.uPixelScale.value = scale;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
