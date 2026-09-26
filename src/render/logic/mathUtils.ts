/**
 * 渲染层纯数学工具（无 THREE 依赖，供单元测试）。
 * 所有函数均为无副作用纯函数。
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** HLSL 风格平滑阶跃：edge0→edge1 之间 0→1（C1 连续） */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 三次缓入缓出：t=0→0、t=0.5→0.5、t=1→1，两端加速度为零（相机切换用） */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 沿最短弧的度角插值（相机方位角回绕用） */
export function lerpAngleDeg(a: number, b: number, t: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * clamp01(t);
}
