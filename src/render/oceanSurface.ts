/**
 * 海面网格 + 波形 ShaderMaterial（THREE 层）。
 * 256×256 分段平面；顶点按 uniform 数组做 Gerstner/正弦位移，
 * 片元做解析法线、菲涅尔、太阳高光、泡沫/白帽、水深调色。
 */
import * as THREE from 'three';
import { OCEAN_FRAG, OCEAN_VERT } from './shaders';
import type { WaveUniformPack } from './logic/uniforms';

/** 深水无实测水深时的视觉默认深度（m） */
export const VISUAL_DEFAULT_DEPTH = 80;

export interface OceanSurface {
  mesh: THREE.Mesh;
  /** 每帧同步 uniform（复用 pack 的 Float32Array 引用，无额外分配） */
  update(
    pack: WaveUniformPack,
    waveTime: number,
    whitecap: number,
    waterDepth: number,
    foamTex?: THREE.Texture | null,
  ): void;
  setWorldSize(size: number): void;
  dispose(): void;
}

/** 无泡沫缓冲时的回退纹理（1×1 黑；纯逻辑测试路径用） */
const EMPTY_FOAM: THREE.Texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
EMPTY_FOAM.needsUpdate = true;

function linearColor(hex: string): THREE.Vector3 {
  const c = new THREE.Color().setStyle(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

/** uniform 缓冲类型与 WaveUniformPack 一致（ArrayBufferLike），便于每帧整包引用赋值 */
function emptyF32(): Float32Array<ArrayBufferLike> {
  return new Float32Array(64);
}

export function createOceanSurface(): OceanSurface {
  const geometry = new THREE.PlaneGeometry(1, 1, 256, 256);
  geometry.rotateX(-Math.PI / 2); // 顶点落在 xz 平面，y=0

  // fog:true 的材质必须自带 UniformsLib.fog（fogColor/fogDensity 等键）：
  // r186 渲染器 refreshFogUniforms 直接读 uniforms.fogColor.value，缺键即每帧 TypeError。
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uAmp: { value: emptyF32() },
    uKx: { value: emptyF32() },
    uKy: { value: emptyF32() },
    uOmega: { value: emptyF32() },
    uPhase: { value: emptyF32() },
    uSteep: { value: emptyF32() },
    uCount: { value: 0 },
    uTime: { value: 0 },
    uWorldSize: { value: 240 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.4, -0.55).normalize() },
    uSunColor: { value: linearColor('#fff2dc') },
    uWhitecap: { value: 0 },
    uWaterDepth: { value: VISUAL_DEFAULT_DEPTH },
    uShallowColor: { value: linearColor('#1b6f6a') },
    uDeepColor: { value: linearColor('#0a2f3f') },
    uSkyHorizon: { value: linearColor('#8fa8a3') },
    uSkyZenith: { value: linearColor('#22343c') },
    uFoamTex: { value: EMPTY_FOAM },
    uFoamWorldSize: { value: 240 },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    side: THREE.DoubleSide, // 水下仰视需要看到波面背面
    fog: true,
    uniforms,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // 顶点位移在 shader 中，包围盒不可信

  return {
    mesh,
    update(pack, waveTime, whitecap, waterDepth, foamTex) {
      // 直接引用 pack 的缓冲：packWaveComponents 每帧覆写同一 Float32Array
      uniforms.uAmp.value = pack.amp;
      uniforms.uKx.value = pack.kx;
      uniforms.uKy.value = pack.ky;
      uniforms.uOmega.value = pack.omega;
      uniforms.uPhase.value = pack.phase;
      uniforms.uSteep.value = pack.steep;
      uniforms.uCount.value = pack.count;
      uniforms.uTime.value = waveTime;
      uniforms.uWhitecap.value = whitecap;
      uniforms.uWaterDepth.value = Number.isFinite(waterDepth)
        ? waterDepth
        : VISUAL_DEFAULT_DEPTH;
      uniforms.uFoamTex.value = foamTex ?? EMPTY_FOAM;
    },
    setWorldSize(size) {
      uniforms.uWorldSize.value = size;
      uniforms.uFoamWorldSize.value = size;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
