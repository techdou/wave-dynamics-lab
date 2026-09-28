/**
 * 浅水海床（THREE 层）：程序化沙底平面 + 焦散光网采样。
 * 位置 y = −视觉水深（overlays.shallowDepth），随浅水模式开/关显示；
 * 覆盖域与海面一致（worldSize）。顶点做解析起伏（双正弦 + 相位噪声感），
 * 片元用 sandBase 程序化沙色（与海面透底近似共用同一 GLSL 片段，保证
 * 「水上俯视透底」与「水下直视海床」观感一致），再叠加焦散纹理亮斑。
 * 水体吸收按深度全局调暗调青；雾遵循场景 FogExp2（fog: true）。
 * 纯装饰层，不参与物理波形与仪器读数。
 */
import * as THREE from 'three';
import { NOISE_GLSL, SAND_COLOR_GLSL } from './shaders';

/** 太阳入射水色（与 renderer 的 sun 色一致，用于焦散染色） */
const SUN_TINT = new THREE.Vector3(1.0, 0.95, 0.86);

export interface Seabed {
  mesh: THREE.Mesh;
  /** depth=视觉水深（m）；worldSize=覆盖域（m）；caustics=焦散纹理 */
  configure(depth: number, worldSize: number, caustics: THREE.Texture | null): void;
  /** 每帧同步波面时间（沙纹微动用） */
  setTime(t: number): void;
  dispose(): void;
}

export function createSeabed(): Seabed {
  const geometry = new THREE.PlaneGeometry(1, 1, 96, 96);
  geometry.rotateX(-Math.PI / 2); // 顶点落在 xz 平面

  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uCausticsTex: { value: null as THREE.Texture | null },
    uCausticsWorldSize: { value: 240 },
    uWorldSize: { value: 240 },
    uDepth: { value: 12 },
    uTime: { value: 0 },
    uSunTint: { value: SUN_TINT },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uWorldSize;
      varying vec3 vWorldPos;
      varying vec3 vSlopeNormal;
      #include <fog_pars_vertex>

      void main() {
        // 先展开到世界尺度水平坐标再算起伏：网格几何是单位平面（xz∈[-0.5,0.5]），
        // 直接对 position 求正弦会让相位范围只有 ±0.5·k，起伏几乎恒为零；
        // 模型矩阵只承担平移（y=−depth），无缩放 → 法线无需逆缩放修正
        vec3 p = vec3(position.x * uWorldSize, 0.0, position.z * uWorldSize);
        // 解析起伏：两组交叉正弦（米尺度频率，幅度 ~0.75m），侧剖面视角给
        // 海床自然轮廓；梯度解析可得 → 法线不依赖导数指令
        float h1 = sin(p.x * 0.21 + p.z * 0.07);
        float h2 = sin(p.x * 0.05 - p.z * 0.17 + 2.1);
        float h3 = sin(p.x * 0.53 + p.z * 0.41 + uTime * 0.05);
        p.y += h1 * 0.28 + h2 * 0.38 + h3 * 0.09;
        float dhx = 0.21 * cos(p.x * 0.21 + p.z * 0.07) * 0.28
                  + 0.05 * cos(p.x * 0.05 - p.z * 0.17 + 2.1) * 0.38
                  + 0.53 * cos(p.x * 0.53 + p.z * 0.41 + uTime * 0.05) * 0.09;
        float dhz = 0.07 * cos(p.x * 0.21 + p.z * 0.07) * 0.28
                  - 0.17 * cos(p.x * 0.05 - p.z * 0.17 + 2.1) * 0.38
                  + 0.41 * cos(p.x * 0.53 + p.z * 0.41 + uTime * 0.05) * 0.09;
        vSlopeNormal = normalize(vec3(-dhx, 1.0, -dhz));
        vec4 worldPos = modelMatrix * vec4(p, 1.0);
        vWorldPos = worldPos.xyz;
        vec4 mvPosition = viewMatrix * worldPos;
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uCausticsTex;
      uniform float uCausticsWorldSize;
      uniform float uDepth;
      uniform float uTime;
      uniform vec3 uSunTint;
      varying vec3 vWorldPos;
      varying vec3 vSlopeNormal;
      #include <fog_pars_fragment>

      ${NOISE_GLSL}
      ${SAND_COLOR_GLSL}

      void main() {
        vec3 n = normalize(vSlopeNormal);
        vec3 col = sandBase(vWorldPos.xz);
        // 坡向明暗（起伏受光）
        col *= 0.75 + 0.45 * clamp(n.y, 0.0, 1.0);

        // 焦散光网：世界坐标 uv 采样（与海面透底近似同一张纹理）
        vec2 cuv = vWorldPos.xz / uCausticsWorldSize + 0.5;
        float ca = texture2D(uCausticsTex, cuv).r;
        col += uSunTint * ca * 0.85;

        // 水体吸收：海床越深整体越暗越青（透射衰减近似）
        float atten = exp(-uDepth / 22.0);
        col *= mix(0.35, 1.0, atten);
        col = mix(col, col * vec3(0.55, 0.85, 0.9), clamp(uDepth / 30.0, 0.0, 0.6));

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    fog: true,
    uniforms,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false; // 深水默认不可见，浅水模式开启时由 renderer 控制
  mesh.frustumCulled = false;

  return {
    mesh,
    configure(depth, worldSize, caustics) {
      uniforms.uDepth.value = Math.max(depth, 0.5);
      uniforms.uCausticsWorldSize.value = worldSize;
      uniforms.uWorldSize.value = worldSize;
      uniforms.uCausticsTex.value = caustics;
      // 尺寸展开在顶点 shader 内完成（uWorldSize），模型矩阵只做深度平移
      mesh.position.y = -Math.max(depth, 0.5);
    },
    setTime(t) {
      uniforms.uTime.value = t;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
