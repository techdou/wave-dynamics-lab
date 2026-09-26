/**
 * GLSL 着色器源码（Three.js ShaderMaterial 用）。
 *
 * 海面数学约定（与 physics.waveField 完全一致，SPEC §5.2）：
 *   η(x,y,t) = Σ aᵢ·sin(kxᵢ·x + kyᵢ·y − ωᵢ·t + φᵢ)      （物理 z-up 坐标）
 *   Gerstner 波面映射 X = x0 + D(x0)，D = Σ qᵢ·aᵢ·cos(θᵢ)·D̂ᵢ（q=0 退化线性 Airy；
 *   physics.evalSurface 以不动点反解 x0 = x − D(x0) 采样同一曲面，两处符号必须一致）
 * 场景映射：场景.x = 物理.x、场景.y = 物理.z、场景.z = −物理.y。
 * 法线在片元着色器按世界坐标解析重算（顶点网格分辨率不足时法线细节不丢）。
 */

/** 波分量 float 数组 uniform 声明（顶点/片元共用） */
export const WAVE_ARRAY_UNIFORMS_GLSL = /* glsl */ `
uniform float uAmp[64];
uniform float uKx[64];
uniform float uKy[64];
uniform float uOmega[64];
uniform float uPhase[64];
uniform float uSteep[64];
uniform int uCount;
uniform float uTime;
`;

export const OCEAN_VERT = /* glsl */ `
${WAVE_ARRAY_UNIFORMS_GLSL}
uniform float uWorldSize;
varying vec3 vWorldPos;
#include <fog_pars_vertex>

void main() {
  vec3 p = vec3(position.x * uWorldSize, 0.0, position.z * uWorldSize);
  float px = p.x;          // 物理 x
  float py = -p.z;         // 物理 y = −场景 z
  vec2 disp = vec2(0.0);   // Gerstner 水平位移（物理 xy 平面）
  float h = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= uCount) break;
    float amp = uAmp[i];
    float th = uKx[i] * px + uKy[i] * py - uOmega[i] * uTime + uPhase[i];
    float k = length(vec2(uKx[i], uKy[i]));
    vec2 dir = k > 1e-6 ? vec2(uKx[i], uKy[i]) / k : vec2(0.0);
    h += amp * sin(th);
    disp += uSteep[i] * amp * cos(th) * dir;
  }
  p.x += disp.x;           // 物理 x' = x + q·a·Dx·cosθ（与 evalSurface 不动点反解 x = x0 + D(x0) 同约定）
  p.z -= disp.y;           // 场景 z = −物理 y' = −(y + q·a·Dy·cosθ)
  p.y = h;                 // 场景 y = 物理 z = η
  vec4 worldPos = modelMatrix * vec4(p, 1.0);
  vWorldPos = worldPos.xyz;
  vec4 mvPosition = viewMatrix * worldPos;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const OCEAN_FRAG = /* glsl */ `
${WAVE_ARRAY_UNIFORMS_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uWhitecap;
uniform float uWaterDepth;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform sampler2D uFoamTex;
uniform float uFoamWorldSize;
varying vec3 vWorldPos;
#include <fog_pars_fragment>

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float px = vWorldPos.x;
  float py = -vWorldPos.z;
  float dhx = 0.0;
  float dhy = 0.0;
  float h = 0.0;
  float ampSum = 1e-4;
  float jac = 1.0; // Gerstner 雅可比：Σ q·a·k·cosθ → <1 表示波面拥挤（破碎前兆）
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
  // 场景系单位法线 = normalize(−ηx, 1, ηy)（由物理 (−ηx, −ηy, 1) 映射）
  vec3 n = normalize(vec3(-dhx, 1.0, dhy));
  float steepness = length(vec2(dhx, dhy));

  // 微观波光：两层滚动噪声扰动法线（亚采样尺度的装饰性涟漪，不含于物理波形）。
  // 平静海况（波分量少）时提供波光与流动感，避免镜面死板；远处淡出防闪烁。
  float detailDist = length(vWorldPos.xz - cameraPosition.xz);
  float detailFade = exp(-detailDist * 0.006);
  if (detailFade > 0.01) {
    float dN1 = valueNoise(vWorldPos.xz * 0.42 + vec2(uTime * 0.31, uTime * 0.19));
    float dN2 = valueNoise(vWorldPos.xz * 1.1 + vec2(-uTime * 0.23, uTime * 0.41));
    vec3 detailN = vec3((dN1 - 0.5) + (dN2 - 0.5) * 0.7, 0.0, (dN1 - 0.5) * 0.8 - (dN2 - 0.5) * 0.6);
    n = normalize(n + detailN * 0.20 * detailFade);
  }

  vec3 V = normalize(cameraPosition - vWorldPos);
  bool aboveSurface = gl_FrontFacing;
  vec3 L = normalize(uSunDir);
  vec3 Hv = normalize(L + V);

  // ---- 水上着色 ----
  float spec = pow(max(dot(n, Hv), 0.0), 240.0);
  float fres = mix(0.028, 1.0, pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0));
  vec3 R = reflect(-V, n);
  vec3 skyRef = mix(uSkyHorizon, uSkyZenith,
                    pow(clamp(R.y, 0.0, 1.0), 0.6));
  // 水深调色：浅水青绿 ↔ 深水藏青（uWaterDepth 为物理水深，深水默认 80 m）
  float depthMix = clamp(uWaterDepth / 40.0, 0.0, 1.0);
  vec3 waterCol = mix(uShallowColor, uDeepColor, depthMix);
  waterCol *= mix(0.7, 1.15, clamp(n.y, 0.0, 1.0)); // 波面朝向增减光
  vec3 above = mix(waterCol, skyRef, fres) + uSunColor * spec * 1.4;

  // ---- 水下仰视（背面）----
  vec3 under = mix(uShallowColor * 1.6, uDeepColor * 1.1, depthMix * 0.6);
  under += uSkyHorizon * 0.18 * clamp(dot(n, V) * -1.0, 0.0, 1.0); // 波底透天光
  under += uSunColor * pow(max(dot(-V, L), 0.0), 60.0) * 0.35;     // 折射日斑
  // Snell 窗：折射成功（未全内反射）的方向透出天空色——水下仰视时随波晃动的
  // 亮天窗，真实潜水最标志性的视觉。移植自 abyssal-ocean (MIT,
  // github.com/squall01337/abyssal-ocean) index.html:1339-1352，按本项目 uniforms 本地化。
  vec3 snellDir = refract(-V, n, 1.333); // 水→空气，n1/n2 = 1.333
  if (dot(snellDir, snellDir) > 1e-4) {
    float skyPick = clamp(snellDir.y, 0.0, 1.0);
    vec3 throughSky = mix(uSkyHorizon, uSkyZenith, pow(skyPick, 0.6));
    under = mix(under, throughSky * 1.12, 0.82);
  }

  // ---- 泡沫：波陡 + 雅可比拥挤 + 白帽强度（波峰加权）----
  float peakNorm = clamp(h / ampSum * 0.5 + 0.5, 0.0, 1.0);

  // 浪尖透光（SSS 近似）：逆光时太阳穿过波峰，波体散射出青绿光——真实海浪
  // 最具辨识度的质感之一。参考 abyssal-ocean（MIT）backLit 分支，按本项目
  // uniforms/峰值归一化本地化：peakNorm 加权波峰，视线与太阳反向时最强。
  float backLit = pow(max(dot(V, -L), 0.0), 3.0) * peakNorm;
  above += vec3(0.10, 0.42, 0.36) * backLit * 0.55;

  float foamSteep = smoothstep(0.42, 0.9, steepness) * 0.55;
  float foamJac = smoothstep(0.88, 0.25, jac) * 0.8;
  float whitecap = peakNorm * uWhitecap * smoothstep(0.45, 0.85, peakNorm + steepness * 0.4);
  // 泡沫包络：时间积累缓冲（雅可比/白帽注入 + 指数衰减 + 风漂，波峰掠过后
  // 余沫留存数秒）为主，瞬时阈值保留 0.7 权重作细节兜底。
  float foamInst = clamp(max(foamSteep + foamJac, whitecap), 0.0, 1.0);
  vec2 foamUv = vWorldPos.xz / uFoamWorldSize + 0.5;
  float foamAcc = texture2D(uFoamTex, foamUv).r;
  float foam = clamp(max(foamInst * 0.7, foamAcc), 0.0, 1.0);
  foam *= 0.55 + 0.45 * valueNoise(vWorldPos.xz * 0.9 + vec2(uTime * 0.15));
  foam *= aboveSurface ? 1.0 : 0.45;
  vec3 foamCol = vec3(0.93, 0.97, 0.98);

  vec3 col = mix(aboveSurface ? above : under, foamCol, foam);
  if (!aboveSurface) col = mix(col, vec3(0.04, 0.24, 0.27), 0.18); // 水下整体色偏

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uUnderShallow;
uniform vec3 uUnderDeep;
uniform float uUnderwater;
// 水下能见度：雾色/密度由渲染器每帧同步（与场景 FogExp2 一致）
uniform vec3 uHazeColor;
uniform float uHazeDensity;
varying vec3 vWorldPos;

void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float y = dir.y;
  vec3 sky = mix(uHorizon, uZenith, pow(smoothstep(0.0, 0.65, y), 0.75));
  sky = mix(uHorizon * 0.85, sky, smoothstep(-0.08, 0.015, y));
  float sd = max(dot(dir, uSunDir), 0.0);
  vec3 sun = uSunColor * (pow(sd, 1200.0) * 1.5 + pow(sd, 20.0) * 0.18);
  vec3 col = sky + sun;
  // 水下渐变：仰视方向更亮（贴近水面透光），俯视深处更暗
  vec3 uw = mix(uUnderDeep, uUnderShallow, smoothstep(-0.75, 0.3, y));
  // 水下光束（装饰）：太阳方向透射亮区，给水体一个明暗主次
  float beam = pow(max(dot(dir, normalize(uSunDir + vec3(0.0, 0.3, 0.0))), 0.0), 16.0);
  uw += uSunColor * beam * 0.20;
  // 能见度衰减：视线越远越混入雾色（近处保渐变、远处归于浑浊 → 水体深度感）
  float dist = length(vWorldPos - cameraPosition);
  float vis = clamp(exp(-uHazeDensity * dist), 0.0, 1.0);
  uw = mix(uHazeColor, uw, vis);
  col = mix(col, uw, clamp(uUnderwater, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export const PARTICLE_VERT = /* glsl */ `
attribute float aFade;
attribute float aSize;
uniform float uPixelScale;
varying float vFade;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale / max(0.2, -mvPosition.z), 1.0, 48.0);
  vFade = aFade;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uTint;
uniform float uOpacity;
varying float vFade;
#include <fog_pars_fragment>
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.12, length(d));
  if (m * vFade < 0.02) discard;
  gl_FragColor = vec4(uTint, m * vFade * uOpacity);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
