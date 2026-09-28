/**
 * 点击涟漪高度场（ping-pong RT，速度格式波动方程）。
 * 独立于物理波形的装饰层：R 通道存高度（m）、G 通道存竖直速度（m/s），
 * 每步 h += v·dt，v += (c²/dx²)·∇²h·dt − 阻尼；点击经 splash() 注入
 * 高斯速度脉冲（把水面往下压，回弹后扩散成圆形涟漪）。
 * 能量停更：最近一次 splash 后约 4·τ 内持续模拟，之后跳过 RT 更新省性能；
 * 暂停/冻结波形时 dt=0 自动冻结（与粒子/泡沫同一时间基准）。
 * 读侧：海面片元按世界坐标 uv 采样高度场做中心差分 → 法线扰动（见 OCEAN_FRAG）。
 * WebGL2 不支持浮点渲染目标（EXT_color_buffer_float）时整个层自动禁用。
 */
import * as THREE from 'three';

const TEX_SIZE = 256;
/** 涟漪衰减时间常数（s）：视觉能量包络 */
const RIPPLE_TAU = 2.4;
/** 涟漪传播视速度（m/s，装饰值；真实毛细波/重力波速随波长色散，此处取观感值） */
const RIPPLE_SPEED = 1.6;

/** 波动方程步进片元（模块级导出供测试检查 GLSL 文本；R/G = 高度 m / 速度 m·s⁻¹）。
 *  uDecay：能量淡出系数（正常模拟恒 1；到期淡出阶段 <1，把场平滑归零再停更，
 *  避免直接停更在水面留下永久高度梯度）。 */
export const RIPPLE_STEP_FRAG = /* glsl */ `
uniform sampler2D tPrev;
uniform float uDelta;
uniform float uWorldSize;
uniform float uDecay;
uniform vec3 uSplash; // uv.xy + 注入强度（速度脉冲，m/s）
varying vec2 vUv;

const float TEXEL = ${1 / TEX_SIZE};

void main() {
  vec4 prev = texture2D(tPrev, vUv);
  float h = prev.r;
  float v = prev.g;
  // 5 点拉普拉斯（边缘邻域 clamp 取自身 = 自然反射边界）
  float hL = texture2D(tPrev, vUv - vec2(TEXEL, 0.0)).r;
  float hR = texture2D(tPrev, vUv + vec2(TEXEL, 0.0)).r;
  float hD = texture2D(tPrev, vUv - vec2(0.0, TEXEL)).r;
  float hU = texture2D(tPrev, vUv + vec2(0.0, TEXEL)).r;
  float dx = uWorldSize / ${TEX_SIZE.toFixed(1)};
  float lap = hL + hR + hD + hU - 4.0 * h;
  // 半隐式步进：h 用新速度推进，v 传播 + 阻尼 + 淡出
  float c2 = ${RIPPLE_SPEED.toFixed(4)} * ${RIPPLE_SPEED.toFixed(4)} / (dx * dx);
  float vn = (v + uDelta * c2 * lap) * exp(-uDelta / ${RIPPLE_TAU.toFixed(4)}) * uDecay;
  // 边缘吸收带：距边 6% 内线性加强阻尼，防能量在边界堆积
  vec2 edge = min(vUv, 1.0 - vUv);
  float absorb = smoothstep(0.0, 0.06, min(edge.x, edge.y));
  vn = mix(vn * 0.6, vn, absorb);
  float hn = (h + vn * uDelta) * uDecay;
  // 点击注入：高斯速度脉冲（半径 ~1.4 m）
  float d2 = dot(vUv - uSplash.xy, vUv - uSplash.xy);
  float radiusUv = 1.4 / uWorldSize;
  vn += uSplash.z * exp(-d2 / (radiusUv * radiusUv)) * step(0.001, abs(uSplash.z));
  gl_FragColor = vec4(hn, vn, 0.0, 1.0);
}
`;

export interface RippleBuffer {
  texture: THREE.Texture;
  /** 是否可用（float RT 支持）；不可用时 splash 为空操作、update 直接返回 */
  readonly available: boolean;
  /** dt=粒子时间增量（≥0，暂停/冻结时为 0）；worldSize=覆盖域 */
  update(dt: number, worldSize: number): void;
  /** 在世界坐标 (sx, sz) 注入一次点击脉冲（strength<0 为下压） */
  splash(sx: number, sz: number, worldSize: number, strength?: number): void;
  dispose(): void;
}

export function createRippleBuffer(renderer: THREE.WebGLRenderer): RippleBuffer {
  // 浮点渲染目标能力检测（WebGL2：EXT_color_buffer_float）
  const gl = renderer.getContext();
  const floatOk =
    renderer.capabilities.isWebGL2 &&
    !!gl.getExtension('EXT_color_buffer_float');
  if (!floatOk) {
    const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    empty.needsUpdate = true;
    return {
      texture: empty,
      available: false,
      update() {},
      splash() {},
      dispose() {
        empty.dispose();
      },
    };
  }

  const rtOpts: THREE.RenderTargetOptions = {
    type: THREE.HalfFloatType,
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

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tPrev: { value: null },
      uDelta: { value: 0 },
      uWorldSize: { value: 240 },
      uDecay: { value: 1 },
      uSplash: { value: new THREE.Vector3(0.5, 0.5, 0) }, // uv.xy + 强度
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: RIPPLE_STEP_FRAG,
  });

  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  quadScene.add(new THREE.Mesh(quadGeometry, mat));

  function clearAll(): void {
    for (const rt of [rtA, rtB]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
  }
  clearAll();

  /**
   * 模拟时间与活动状态机：
   *   activeUntil = 最近一次 splash 后保持模拟的截止（模拟时间）
   *   fadeUntil   = 截止后的淡出完成时刻（淡出阶段 uDecay<1 把场平滑归零，
   *                 避免「直接停更」在水面留下永久高度梯度）
   *   settled     = 淡出完成且已清场，跳过 RT 更新直到下一次 splash
   * 计时与步进一致：elapsed 按钳制后的步长累计（shader 的 uDelta 同源），
   * 低帧率下不会「提前停更」。
   */
  const STEP_CLAMP_S = 1 / 30;
  const FADE_SECONDS = 3.0;
  /** 淡出阶段每步能量系数（0.985/步 @60fps ≈ 每秒衰减到 40%，3s 后近零） */
  const FADE_DECAY_PER_STEP = 0.985;
  let elapsed = 0;
  let activeUntil = -1;
  let fadeUntil = -1;
  let settled = true;
  /** 待注入脉冲（本帧 update 时写入 uniform，之后清零） */
  const pendingSplash = new THREE.Vector3(0, 0, 0);
  let hasPendingSplash = false;

  return {
    get texture(): THREE.Texture {
      return rtA.texture;
    },
    available: true,

    update(dt, worldSize) {
      if (Math.abs(worldSize - currentWorldSize) > 0.5) {
        currentWorldSize = worldSize;
        clearAll(); // 覆盖域变化：旧涟漪作废
        settled = true;
        fadeUntil = -1;
      }
      const step = Math.min(Math.max(dt, 0), STEP_CLAMP_S);
      if (hasPendingSplash) {
        settled = false;
        fadeUntil = -1;
        activeUntil = elapsed + RIPPLE_TAU * 4;
      }
      if (settled) {
        pendingSplash.set(0, 0, 0);
        hasPendingSplash = false;
        return;
      }
      // 暂停/冻结波形：涟漪冻结（与粒子同一时间基准），脉冲留到恢复后注入
      if (step <= 0 && !hasPendingSplash) return;
      elapsed += step;

      const u = mat.uniforms as { [k: string]: { value: unknown } };
      u['tPrev']!.value = rtA.texture;
      u['uDelta']!.value = step;
      u['uWorldSize']!.value = worldSize;
      // 到期淡出：截止后以固定系数衰减场能量，FADE_SECONDS 后清场停更
      const fading = elapsed > activeUntil;
      if (fading && fadeUntil < 0) fadeUntil = elapsed + FADE_SECONDS;
      u['uDecay']!.value = fading ? FADE_DECAY_PER_STEP : 1;
      (u['uSplash']!.value as THREE.Vector3).copy(pendingSplash);
      pendingSplash.set(0, 0, 0);
      hasPendingSplash = false;

      if (fadeUntil > 0 && elapsed > fadeUntil) {
        clearAll();
        settled = true;
        fadeUntil = -1;
        return;
      }

      renderer.setRenderTarget(rtB);
      renderer.render(quadScene, quadCam);
      renderer.setRenderTarget(null);
      const swap = rtA;
      rtA = rtB;
      rtB = swap;
    },

    splash(sx, sz, worldSize, strength = -0.9) {
      pendingSplash.set(sx / worldSize + 0.5, sz / worldSize + 0.5, strength);
      hasPendingSplash = true;
    },

    dispose() {
      rtA.dispose();
      rtB.dispose();
      mat.dispose();
      quadGeometry.dispose();
      quadScene.clear();
    },
  };
}
