/**
 * 屏幕空间体积光（god rays）—— 遮罩径向模糊实现（GPU Gems 3 经典方案）。
 * 遮罩：太阳圆盘（天空穹顶临时换用 mask 材质）+ 波面几何作纯黑遮挡体，
 * 渲染到半分辨率 RT——光柱被真实波形遮挡，随波面起伏实时流动。
 * 合成：向太阳屏幕位置径向模糊采样遮罩，按 uIntensity（随水下过渡增强）
 * 叠加进场景，挂在后处理链 RenderPass 之后、Bloom 之前。
 * 说明：未采用社区包 three-good-godrays——它绑定 pmndrs/postprocessing 框架
 * （与 three 官方 EffectComposer 链不兼容，接入需整链重写），且 peer 声明仅
 * 覆盖 three ≤ 0.182（本项目 0.186 无官方背书）；本实现零新依赖，遮挡体即
 * 波面几何，视觉同档。
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { IUniform } from 'three/src/renderers/shaders/UniformsLib.js';
import { SKY_VERT } from './shaders';

/** 太阳遮挡遮罩材质（渲染天空穹顶时临时换上：仅太阳圆盘+光晕为亮） */
export function createSunMaskMaterial(sunDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: sunDir } },
    vertexShader: SKY_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos - cameraPosition);
        float d = dot(dir, uSunDir);
        // 视觉放大的太阳盘（真实约 0.5°，太小无法形成光柱主体）
        float disk = smoothstep(0.9970, 0.9990, d);
        float glow = pow(max(d, 0.0), 350.0) * 0.7;
        gl_FragColor = vec4(vec3(disk + glow), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

/** 纯黑遮挡体材质（波面临时换用；fog 关闭保证遮罩纯色；水下仰视需双面） */
export function createOccluderMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0x000000,
    fog: false,
    side: THREE.DoubleSide,
  });
}

/** 径向模糊合成 pass（tMask 由 renderer 每帧用遮罩渲染填充） */
export function createGodRaysPass(mask: THREE.Texture): ShaderPass {
  const shader = {
    uniforms: {
      tDiffuse: { value: null },
      // 注意：此处不能直接放 render target 纹理——ShaderPass 构造时会
      // UniformsUtils.clone，RT 纹理会被置 null 并告警；构造后再赋值。
      tMask: { value: null },
      uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
      uIntensity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform sampler2D tMask;
      uniform vec2 uSunScreen;
      uniform float uIntensity;
      varying vec2 vUv;

      void main() {
        vec4 scene = texture2D(tDiffuse, vUv);
        if (uIntensity <= 0.001) {
          gl_FragColor = scene;
          return;
        }
        const int SAMPLES = 24;
        vec2 delta = (uSunScreen - vUv) * (1.0 / float(SAMPLES)) * 0.9;
        vec2 uv = vUv;
        float illumDecay = 1.0;
        float acc = 0.0;
        for (int i = 0; i < SAMPLES; i++) {
          uv += delta;
          acc += texture2D(tMask, clamp(uv, vec2(0.001), vec2(0.999))).r * illumDecay;
          illumDecay *= 0.93;
        }
        acc /= float(SAMPLES);
        // 冷白色光柱（与 uSunColor 略作区分：水下散射偏蓝）
        vec3 tint = vec3(0.85, 0.95, 1.0);
        gl_FragColor = vec4(scene.rgb + tint * (acc * uIntensity * 1.7), scene.a);
      }
    `,
  };
  const pass = new ShaderPass(shader);
  (pass.uniforms as { [k: string]: { value: unknown } })['tMask']!.value = mask;
  return pass;
}

/** 从 uniforms 取类型化值的辅助（ShaderPass 的 uniforms 键为可选索引类型） */
export function passUniform<T>(pass: ShaderPass, name: string): T {
  return (pass.uniforms as { [k: string]: { value: unknown } })[name]!.value as T;
}

export type { IUniform };
