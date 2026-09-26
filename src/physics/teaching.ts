/**
 * 教学对照数据 —— 支撑『波形传播 ≠ 水质点前移』
 * ============================================================
 * 核心教学事实（线性 Airy 波）：
 *   - 波形（相位）以相速度 c = λ/T 前进：深水 c = g·T/(2π) ≈ 1.56·T（m/s）；
 *   - 水质点只在原地做圆（深水）或椭圆（有限水深）运动，不随波形前移：
 *       深水：轨迹半径 a·e^{kz}，表面直径 = 2a = 波高 H；
 *       有限深水：水平半轴 a·cosh(k(z+h))/sinh(kh)，垂直半轴 a·sinh(k(z+h))/sinh(kh)，
 *       随深度增大椭圆压扁，水底（z=−h）只剩水平往复。
 * 供 UI/数据层在"模型说明"面板引用；本模块只产纯数据，不做 DOM。
 */
import { solveWaveNumber } from './dispersion';

/** 相速度 c（m/s）；输入周期 T（s）与水深 h（m，∞ = 深水）。守卫：非法输入返回 0 */
export function wavePhaseSpeed(period: number, depth: number): number {
  if (!Number.isFinite(period) || period <= 0) return 0;
  const omega = (2 * Math.PI) / period;
  const k = solveWaveNumber(omega, depth);
  return k > 1e-12 ? omega / k : 0;
}

/**
 * 水质点轨迹（水平）直径（m）。
 * @param amp   分量振幅 a（m）
 * @param z     静水深坐标（≤0，0 = 静水面）
 * 深水 2a·e^{kz}；有限深水 2a·cosh(k(z+h))/sinh(kh)（浅水压扁，见 MODELS.md）。
 */
export function orbitDiameter(
  amp: number,
  period: number,
  depth: number,
  z: number,
): number {
  if (!Number.isFinite(amp) || amp <= 0 || !Number.isFinite(period) || period <= 0) return 0;
  const omega = (2 * Math.PI) / period;
  const k = solveWaveNumber(omega, depth);
  if (k <= 1e-12) return 0;
  if (!Number.isFinite(depth) || depth <= 1e-3) {
    const zc = Math.min(z, 0); // 深水守卫：z>0 视为水面
    return 2 * amp * Math.exp(k * zc);
  }
  const zc = Math.min(Math.max(z, -depth), 0);
  const kh = k * depth;
  if (kh < 1e-6) return 2 * amp * Math.exp(k * zc); // 极浅退化守卫 → 深水公式兜底
  // cosh(u)/sinh(v) 数值稳定形式：e^{u-v}·(1+e^{-2u})/(1-e^{-2v})，u≤v ⇒ 不溢出
  const u = k * (zc + depth);
  const ratio = Math.exp(u - kh) * ((1 + Math.exp(-2 * u)) / (1 - Math.exp(-2 * kh)));
  return 2 * amp * ratio;
}

/** 波形 vs 质点的教学对照数据（单一规则波） */
export interface WaveTeachingInfo {
  /** 波周期 T（s） */
  period: number;
  /** 波长 λ（m） */
  wavelength: number;
  /** 相速度 c = λ/T（m/s）—— 波形前进速度 */
  phaseSpeed: number;
  /** 静水面水质点轨迹直径（m）= 波高 H（线性理论） */
  surfaceOrbitDiameter: number;
  /** 指定静水深 z 处的轨迹直径（m） */
  orbitDiameterAtZ: number;
  /** 该深度的衰减比（相对表面），深水 = e^{kz} */
  decayRatioAtZ: number;
}

/**
 * 组装单一规则波的教学对照数据。
 * @param waveHeight 波高 H（m，波峰到波谷；线性理论振幅 a = H/2）
 * @param period     周期 T（s）
 * @param depth      水深 h（m，∞ = 深水）
 * @param z          参考静水深（≤0，默认 0 = 水面）
 */
export function waveTeachingInfo(
  waveHeight: number,
  period: number,
  depth: number,
  z = 0,
): WaveTeachingInfo {
  const periodSafe = Number.isFinite(period) && period > 0 ? period : 1;
  const amp = Number.isFinite(waveHeight) && waveHeight > 0 ? waveHeight / 2 : 0;
  const zSafe = Number.isFinite(z) ? Math.min(z, 0) : 0;
  const omega = (2 * Math.PI) / periodSafe;
  const k = solveWaveNumber(omega, depth);
  const surface = orbitDiameter(amp, periodSafe, depth, 0);
  const atZ = orbitDiameter(amp, periodSafe, depth, zSafe);
  return {
    period: periodSafe,
    wavelength: k > 1e-12 ? (2 * Math.PI) / k : 0,
    phaseSpeed: k > 1e-12 ? omega / k : 0,
    surfaceOrbitDiameter: surface,
    orbitDiameterAtZ: atZ,
    decayRatioAtZ: surface > 1e-12 ? atZ / surface : 0,
  };
}
