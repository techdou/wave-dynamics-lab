/**
 * 水下屏幕空间 pass —— "泡在水里"的临场感（装饰性，不影响物理读数）。
 * 双频正弦 UV 扭曲 + 轻微径向色差 + 青绿色偏与边缘暗角，全部按
 * uBlend（水下过渡系数 0–1）插值，水面上完全无感。
 * 基于官方 ShaderPass 挂在 EffectComposer 链尾（OutputPass 之前）。
 */
import type { IUniform } from 'three/src/renderers/shaders/UniformsLib.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** ShaderPass 构造参数形状（官方类型未导出 Shader 接口，本地声明） */
interface ScreenShader {
  uniforms: { [uniform: string]: IUniform };
  vertexShader: string;
  fragmentShader: string;
}

export const UnderwaterShader: ScreenShader = {
  uniforms: {
    tDiffuse: { value: null },
    uBlend: { value: 0 },
    uTime: { value: 0 },
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
    uniform float uBlend;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
      if (uBlend < 0.005) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      // 水波折射扭曲：两个不同频率/速度的正弦扰动叠加，靠近上下边缘稍强
      float edgeBias = 1.0 + (abs(vUv.y - 0.5) * 2.0) * 0.35;
      vec2 wob = vec2(
        sin(vUv.y * 16.0 + uTime * 1.25) * 0.0032,
        sin(vUv.x * 13.0 - uTime * 0.85 + vUv.y * 5.0) * 0.0024
      ) * edgeBias * uBlend;
      vec2 uv = vUv + wob;

      vec3 col = texture2D(tDiffuse, uv).rgb;
      // 轻微色差（水中折射色散观感）
      float ca = 0.0014 * uBlend;
      col.r = texture2D(tDiffuse, uv + vec2(ca, 0.0)).r;
      col.b = texture2D(tDiffuse, uv - vec2(ca, 0.0)).b;

      // 青绿微色偏（水体的选择性吸收）与边缘暗角（镜框感/光衰减）
      col *= mix(vec3(1.0), vec3(0.90, 1.015, 1.03), uBlend);
      vec2 d = vUv - 0.5;
      col *= 1.0 - dot(d, d) * 0.5 * uBlend;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export interface UnderwaterPass extends ShaderPass {
  /** blend = 水下过渡系数 [0,1]；time = 仿真时间（与波面同一时钟，暂停即停） */
  update(blend: number, time: number): void;
}

export function createUnderwaterPass(): UnderwaterPass {
  const pass = new ShaderPass(UnderwaterShader) as UnderwaterPass;
  const uBlend = pass.uniforms.uBlend as IUniform<number>;
  const uTime = pass.uniforms.uTime as IUniform<number>;
  pass.update = (blend: number, time: number): void => {
    uBlend.value = Math.min(1, Math.max(0, blend));
    uTime.value = time;
    pass.enabled = uBlend.value > 0.005;
  };
  return pass;
}
