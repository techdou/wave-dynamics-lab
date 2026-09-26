/**
 * 实验二造波机推板 / 随浪浮标的位置学（纯逻辑，供单元测试）。
 * 相位全部来自真实波形参数（store.params.interference.makerA/B），
 * 禁止任何"看起来在动"的假动画。
 */
import { degToRad } from './mathUtils';

/**
 * 推板活塞位移（m，沿传播方向）：波源处（传播距离 s=0）波面
 * η_src = a·sin(−ω·t + φ) ⇒ 活塞位移取同相 a·sin(φ − ω·t)。
 * @param amp 物理振幅（= 波高 H/2）
 * @param phaseDeg 初相位（deg，物理 API 度）
 * @param period 周期 T（s）
 * @param t 波形时间（冻结波形时为冻结时刻）
 */
export function paddleDisplacement(
  amp: number,
  phaseDeg: number,
  period: number,
  t: number,
): number {
  const omega = (2 * Math.PI) / Math.max(period, 1e-6);
  return amp * Math.sin(degToRad(phaseDeg) - omega * t);
}

/** 造波机传播方向（物理）d = (sinθ, cosθ) → 场景 d_s = (sinθ, −cosθ) */
export function propagationSceneDir(angleDeg: number): { dx: number; dz: number } {
  const th = degToRad(angleDeg);
  return { dx: Math.sin(th), dz: -Math.cos(th) };
}

/**
 * 推板铰点（板面中心基准位）场景坐标：
 * 源在传播反方向的边界处，两块板沿深度错开 lane·7 m 防重叠穿模。
 */
export function paddleHinge(
  angleDeg: number,
  worldSize: number,
  lane: number,
): { x: number; z: number; half: number } {
  const { dx, dz } = propagationSceneDir(angleDeg);
  const half = worldSize / 2 - 6 - lane * 7;
  return { x: -dx * half, z: -dz * half, half };
}

/**
 * 浮标场景坐标：水平 = store.probe（场景 z 取反），竖直 = 该处波面 η。
 * （η 由 renderer 调 physics.evalSurface 取得，此处只做坐标映射。）
 */
export function buoyScenePosition(
  probeX: number,
  probeY: number,
  eta: number,
): { x: number; y: number; z: number } {
  return { x: probeX, y: eta, z: -probeY };
}

/**
 * 浮标随波面法线摇摆的四元数轴角（场景系）：
 * 物理法线 (a,b,c) → 场景 (a, c, −b)；倾斜角 = acos(n·ŷ)。
 */
export function buoyTiltFromNormal(normal: {
  x: number;
  y: number;
  z: number;
}): { axisX: number; axisY: number; axisZ: number; angle: number } {
  const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const ns = { x: normal.x / len, y: normal.z / len, z: -normal.y / len };
  const angle = Math.acos(Math.min(1, Math.max(-1, ns.y)));
  // 旋转轴 = ŷ × n_s（单位化）；法线近竖直时角≈0，轴任意取 x 轴
  let ax = ns.z;
  let az = -ns.x;
  const alen = Math.hypot(ax, az);
  if (alen < 1e-6) {
    ax = 1;
    az = 0;
    return { axisX: ax, axisY: 0, axisZ: az, angle: 0 };
  }
  ax /= alen;
  az /= alen;
  return { axisX: ax, axisY: 0, axisZ: az, angle };
}
