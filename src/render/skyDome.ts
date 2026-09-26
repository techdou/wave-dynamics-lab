/**
 * 天空渐变穹顶 + 太阳（THREE 层）。
 * 单一大球 BackSide 着色：天顶→地平线渐变、太阳盘面与光晕；
 * uUnderwater ∈ [0,1] 在天空渐变与水下蓝绿渐变之间过渡，
 * 太阳方向与海面高光共用同一 uniform 值（renderer 注入）。
 */
import * as THREE from 'three';
import { SKY_FRAG, SKY_VERT } from './shaders';

export interface SkyDome {
  mesh: THREE.Mesh;
  /** 水下过渡系数 [0,1]（0 = 全天空，1 = 全水下渐变） */
  setUnderwaterBlend(blend: number): void;
  /** 同步水下能见度（雾色/密度，与场景 FogExp2 每帧一致） */
  setWaterHaze(density: number, color: THREE.Color): void;
  dispose(): void;
}

function linearColor(hex: string): THREE.Vector3 {
  const c = new THREE.Color().setStyle(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export function createSkyDome(radius: number): SkyDome {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.45, 0.4, -0.55).normalize() },
    uSunColor: { value: linearColor('#fff2dc') },
    uZenith: { value: linearColor('#22343c') },
    uHorizon: { value: linearColor('#8fa8a3') },
    uUnderShallow: { value: linearColor('#2e8f8a') },
    uUnderDeep: { value: linearColor('#04222e') },
    uUnderwater: { value: 0 },
    uHazeColor: { value: linearColor('#0d454c') },
    uHazeDensity: { value: 0.0009 },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1; // 最先绘制作为背景

  return {
    mesh,
    setUnderwaterBlend(blend) {
      uniforms.uUnderwater.value = Math.min(1, Math.max(0, blend));
    },
    setWaterHaze(density, color) {
      uniforms.uHazeDensity.value = density;
      const v = uniforms.uHazeColor.value as THREE.Vector3;
      v.set(color.r, color.g, color.b);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
