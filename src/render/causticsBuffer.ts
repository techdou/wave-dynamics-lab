/**
 * 浅水焦散纹理（折射网格法，每帧全量重绘的单 RT pass）。
 * 方法源自 Evan Wallace《WebGL Water》的 refracted-grid caustics：
 *   在 RT 上渲染一张 N×N 参数网格，顶点取波面点（与海面同源的 Gerstner 解析
 *   波形 + 微观噪声扰动），沿太阳方向折射后与海床平面求交，得到落点 uv；
 *   片元用「落点uv面积 / 参数uv面积」的屏幕导数行列式比得到局部面积压缩比，
 *   压缩越强光越亮——光网的物理本质（波面透镜聚焦/发散）。
 *   导数比的形式让相机缩放/分辨率因子在分子分母中约掉，强度不随视角漂移。
 * 读侧：海床 mesh 与海面片元（浅水透底近似）各自按世界坐标 uv 采样同一张纹理。
 * 覆盖域与泡沫缓冲一致：worldSize 世界域，uv = sceneXZ/worldSize + 0.5。
 * 纯装饰层，不参与物理波形与仪器读数。
 */
import * as THREE from 'three';
import { NOISE_GLSL, WAVE_ARRAY_UNIFORMS_GLSL } from './shaders';
import type { WaveUniformPack } from './logic/uniforms';

const TEX_SIZE = 512;
/** 折射网格分段数（顶点 257² ≈ 6.6 万，一次 draw） */
const GRID_SEGMENTS = 256;
/** 基准亮度增益：平坦水面（paramArea = 1/TEX²）时 intensity ≈ 1 */
const CAUSTIC_GAIN = 0.85;

/**
 * 折射网格顶点着色器（模块级导出供测试检查 GLSL 文本）。
 * 关键：顶点被重投影到折射落点（vBedUv → 裁剪空间）——光能沉积在真实落点，
 * 落点聚集处三角形在 RT 上物理重叠形成亮斑（Wallace 原法），而非在入射位置
 * 画强度场。落点出域的顶点被视锥裁剪自然剔除。
 */
export const CAUSTICS_VERT = /* glsl */ `
${WAVE_ARRAY_UNIFORMS_GLSL}
uniform float uWorldSize;
uniform float uDepth;
uniform vec3 uSunDirPhys; // 物理系（z-up），已归一
varying vec2 vParam;

${NOISE_GLSL}

void main() {
  vParam = uv;
  // 参数 uv → 世界域（uv.x ↔ sceneX，uv.y ↔ sceneZ）→ 物理坐标（py = −sceneZ）
  vec2 world = (uv - 0.5) * uWorldSize;
  float px = world.x;
  float py = -world.y;
  // 与 OCEAN_FRAG 同源的解析波形：高度 + 梯度
  float h = 0.0;
  float dhx = 0.0;
  float dhy = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= uCount) break;
    float amp = uAmp[i];
    float th = uKx[i] * px + uKy[i] * py - uOmega[i] * uTime + uPhase[i];
    float c = cos(th);
    h += amp * sin(th);
    dhx += amp * c * uKx[i];
    dhy += amp * c * uKy[i];
  }
  // 微观噪声扰动（同海面 detail，系数更大——焦散碎光对扰动更敏感）
  float n1 = valueNoise(world * 0.42 + vec2(uTime * 0.31, uTime * 0.19));
  float n2 = valueNoise(world * 1.1 + vec2(-uTime * 0.23, uTime * 0.41));
  dhx += ((n1 - 0.5) + (n2 - 0.5) * 0.7) * 0.5;
  dhy += ((n1 - 0.5) * 0.8 - (n2 - 0.5) * 0.6) * 0.5;

  // 物理系（z-up）：波面点与法线
  vec3 P = vec3(px, py, h);
  vec3 N = normalize(vec3(-dhx, -dhy, 1.0));
  vec3 T = refract(-uSunDirPhys, N, 0.75); // 空气→水，eta = 1/1.333
  // 折射向下才与海床相交；否则（全内反射/向上）落点推到域外 → 视锥裁剪剔除
  float t = T.z < -1e-4 ? (-uDepth - P.z) / T.z : 1e6;
  vec3 B = P + t * T;
  // 物理交点 → 场景 xz → RT uv 域（与海床采样约定一致）→ 裁剪空间
  vec2 bedUv = vec2(B.x, -B.y) / uWorldSize + 0.5;
  gl_Position = vec4(bedUv * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * 焦散片元：每像素沉积的「参数面积」反比于光强（模块级导出供测试检查）。
 * 无折射时每像素恰好对应基准参数面积 (1/TEX)² → intensity ≈ 1；落点聚焦处
 * 三角形在 RT 上收缩、单像素覆盖的参数面积变大 → intensity > 1 变亮。
 * 本 pass 相机无关（正交参数域 → RT），强度稳定不随视角漂移。
 */
export const CAUSTICS_FRAG = /* glsl */ `
varying vec2 vParam;

void main() {
  float paramArea = abs(dFdx(vParam.x) * dFdy(vParam.y) - dFdx(vParam.y) * dFdy(vParam.x));
  float intensity = ${(1 / (TEX_SIZE * TEX_SIZE)).toExponential(8)} / max(paramArea, 1e-9);
  // 软化 + 上限：HalfFloat RT 下保留 0..~5 的聚焦层次
  float value = pow(clamp(intensity, 0.0, 4.0), 1.6) * ${CAUSTIC_GAIN.toFixed(3)};
  gl_FragColor = vec4(value, 0.0, 0.0, 1.0);
}
`;

export interface CausticsBuffer {
  texture: THREE.Texture;
  /** waveT=波面时间；worldSize=覆盖域；depth=浅水视觉水深（海床平面位置） */
  update(waveT: number, worldSize: number, depth: number, pack: WaveUniformPack): void;
  dispose(): void;
}

export function createCausticsBuffer(renderer: THREE.WebGLRenderer): CausticsBuffer {
  // HalfFloat RT 保留聚焦高光的 >1 层次；不支持时退 UnsignedByte（高光剪白，
  // 低端设备可接受）。检测的扩展与涟漪高度场一致：EXT_color_buffer_float。
  const gl = renderer.getContext();
  const halfFloatOk =
    renderer.capabilities.isWebGL2 && !!gl.getExtension('EXT_color_buffer_float');
  const rt = new THREE.WebGLRenderTarget(TEX_SIZE, TEX_SIZE, {
    type: halfFloatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });

  // 物理系太阳方向（z-up）在 CPU 侧换算好传入（场景系 → 物理系：py = −sceneZ）
  const mat = new THREE.ShaderMaterial({
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
      uWorldSize: { value: 240 },
      uDepth: { value: 12 },
      uSunDirPhys: { value: new THREE.Vector3(0.45, 0.55, 0.4).normalize() },
    },
    vertexShader: CAUSTICS_VERT,
    fragmentShader: CAUSTICS_FRAG,
    // 折射落点重叠 = 光能沉积：加性混合叠加重叠光斑；无深度语义
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quadGeometry = new THREE.PlaneGeometry(2, 2, GRID_SEGMENTS, GRID_SEGMENTS);
  quadScene.add(new THREE.Mesh(quadGeometry, mat));

  return {
    texture: rt.texture,
    update(waveT, worldSize, depth, pack) {
      const u = mat.uniforms as { [k: string]: { value: unknown } };
      u['uAmp']!.value = pack.amp;
      u['uKx']!.value = pack.kx;
      u['uKy']!.value = pack.ky;
      u['uOmega']!.value = pack.omega;
      u['uPhase']!.value = pack.phase;
      u['uSteep']!.value = pack.steep;
      u['uCount']!.value = pack.count;
      u['uTime']!.value = waveT;
      u['uWorldSize']!.value = worldSize;
      u['uDepth']!.value = Math.max(depth, 0.5);
      renderer.setRenderTarget(rt);
      renderer.render(quadScene, quadCam);
      renderer.setRenderTarget(null);
    },
    dispose() {
      rt.dispose();
      mat.dispose();
      quadGeometry.dispose();
      quadScene.clear();
    },
  };
}
