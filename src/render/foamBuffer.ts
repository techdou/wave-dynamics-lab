/**
 * 物理泡沫积累缓冲（ping-pong RT）——浪花白沫的时间维度。
 * 注入：与海面片元同源的破碎判据（Gerstner 雅可比拥挤 + 局部陡度 + 波峰×白帽强度）；
 * 演化：按仿真时间指数衰减（tau ≈ 2.6s）+ 沿风向缓慢漂移（浪花随波推进的观感）。
 * 读侧：海面片元以世界坐标查此纹理作为泡沫包络（替代瞬时阈值的主要部分），
 * 波峰掠过后泡沫留存数秒再消散——瞬时阈值法做不到的"余沫"。
 * 512² 覆盖当前 worldSize 水域；暂停/冻结波形时 dt=0 即冻结（与粒子同一时间基准）。
 * 装饰性视觉细节，不参与物理波形与仪器读数。
 */
import * as THREE from 'three';
import { WAVE_ARRAY_UNIFORMS_GLSL } from './shaders';
import type { WaveUniformPack } from './logic/uniforms';

const TEX_SIZE = 512;
/** 泡沫存续时间常数（s）：波峰掠过后白沫留存时长 */
const FOAM_TAU = 2.6;
/** 风漂速度（m/s，视觉）：泡沫包络沿风向的推进观感 */
const FOAM_DRIFT = 0.4;

export interface FoamBuffer {
  texture: THREE.Texture;
  /** dt=粒子时间增量（≥0）；waveT=波面时间；whitecap=白帽强度；worldSize=缓冲覆盖域 */
  update(
    dt: number,
    waveT: number,
    whitecap: number,
    windDirDeg: number,
    worldSize: number,
    pack: WaveUniformPack,
  ): void;
  dispose(): void;
}

export function createFoamBuffer(renderer: THREE.WebGLRenderer): FoamBuffer {
  const rtOpts: THREE.RenderTargetOptions = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  };
  let rtA = new THREE.WebGLRenderTarget(TEX_SIZE, TEX_SIZE, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(TEX_SIZE, TEX_SIZE, rtOpts);
  let currentWorldSize = -1;

  const updateMat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone({
        uAmp: { value: null },
        uKx: { value: null },
        uKy: { value: null },
        uOmega: { value: null },
        uPhase: { value: null },
        uSteep: { value: null },
        uCount: { value: 0 },
        uTime: { value: 0 },
      }),
      tPrev: { value: null },
      uDelta: { value: 0 },
      uWhitecap: { value: 0 },
      uWorldSize: { value: 240 },
      uWindDir: { value: new THREE.Vector2(0, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${WAVE_ARRAY_UNIFORMS_GLSL}
      uniform sampler2D tPrev;
      uniform float uDelta;
      uniform float uWhitecap;
      uniform float uWorldSize;
      uniform vec2 uWindDir;
      varying vec2 vUv;

      void main() {
        // uv 域 → 场景世界域（x 右，y = 场景 z）→ 物理坐标（py = −场景 z）
        vec2 world = (vUv - 0.5) * uWorldSize;
        float px = world.x;
        float py = -world.y;
        float h = 0.0;
        float dhx = 0.0;
        float dhy = 0.0;
        float jac = 1.0;
        float ampSum = 1e-4;
        for (int i = 0; i < 64; i++) {
          if (i >= uCount) break;
          float amp = uAmp[i];
          float k = length(vec2(uKx[i], uKy[i]));
          float th = uKx[i] * px + uKy[i] * py - uOmega[i] * uTime + uPhase[i];
          float c = cos(th);
          h += amp * sin(th);
          dhx += amp * c * uKx[i];
          dhy += amp * c * uKy[i];
          jac -= uSteep[i] * amp * k * c;
          ampSum += amp;
        }
        float steep = length(vec2(dhx, dhy));
        float peakNorm = clamp(h / ampSum * 0.5 + 0.5, 0.0, 1.0);
        // 注入判据与 OCEAN_FRAG 完全同源（雅可比拥挤 + 陡度 + 白帽波峰）
        float breaking = smoothstep(0.88, 0.25, jac) * 0.8 + smoothstep(0.42, 0.9, steep) * 0.55;
        float cap = peakNorm * uWhitecap * smoothstep(0.45, 0.85, peakNorm + steep * 0.4);
        float target = clamp(max(breaking, cap), 0.0, 1.0);

        // 演化：指数衰减 + 上限刷新；沿风向缓漂（读上一帧时向风反方向取样本）
        vec2 prevUv = vUv - uWindDir * (FOAM_DRIFT_PLACEHOLDER * uDelta / max(uWorldSize, 1.0));
        float prev = texture2D(tPrev, prevUv).r;
        float next = clamp(max(prev * exp(-uDelta / FOAM_TAU_PLACEHOLDER), target), 0.0, 1.0);
        gl_FragColor = vec4(next, 0.0, 0.0, 1.0);
      }
    `,
  });
  // 常量直接内联进 GLSL（避免运行时 uniform 开销）
  updateMat.fragmentShader = updateMat.fragmentShader
    .replace('FOAM_DRIFT_PLACEHOLDER', FOAM_DRIFT.toFixed(4))
    .replace('FOAM_TAU_PLACEHOLDER', FOAM_TAU.toFixed(4));

  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), updateMat));

  function clearAll(): void {
    for (const rt of [rtA, rtB]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
  }
  clearAll();

  return {
    get texture(): THREE.Texture {
      return rtA.texture;
    },
    update(dt, waveT, whitecap, windDirDeg, worldSize, pack) {
      if (Math.abs(worldSize - currentWorldSize) > 0.5) {
        currentWorldSize = worldSize;
        clearAll(); // 覆盖域变化：旧积累作废
      }
      const u = updateMat.uniforms as { [k: string]: { value: unknown } };
      u['uAmp']!.value = pack.amp;
      u['uKx']!.value = pack.kx;
      u['uKy']!.value = pack.ky;
      u['uOmega']!.value = pack.omega;
      u['uPhase']!.value = pack.phase;
      u['uSteep']!.value = pack.steep;
      u['uCount']!.value = pack.count;
      u['uTime']!.value = waveT;
      u['tPrev']!.value = rtA.texture;
      u['uDelta']!.value = Math.max(0, dt);
      u['uWhitecap']!.value = whitecap;
      u['uWorldSize']!.value = worldSize;
      const th = (windDirDeg * Math.PI) / 180;
      (u['uWindDir']!.value as THREE.Vector2).set(Math.sin(th), -Math.cos(th));
      renderer.setRenderTarget(rtB);
      renderer.render(quadScene, quadCam);
      renderer.setRenderTarget(null);
      const swap = rtA;
      rtA = rtB;
      rtB = swap;
    },
    dispose() {
      rtA.dispose();
      rtB.dispose();
      updateMat.dispose();
    },
  };
}
