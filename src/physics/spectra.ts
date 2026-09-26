/**
 * 海浪谱模块 —— PM / JONSWAP（教学版）
 * ============================================================
 * PM 谱（Pierson–Moskowitz，1964，充分发展风浪）：
 *   S(f) = α·g²·(2π)⁻⁴·f⁻⁵·exp(−1.25·(fp/f)⁴)，α = 0.0081，
 *   fp = 0.877·g/(2π·U)（U 为 19.5 m 高度等效风速）。
 *   解析零阶矩：m0 = ∫S df = α·g²·(2π)⁻⁴·fp⁻⁴/5（换元 u=1.25(fp/f)⁴ 可闭式积分），
 *   与经典关系 Hs = 4√m0 ≈ 0.209·U²/g（教科书常记 0.21）自洽。
 *
 * JONSWAP 谱（Hasselmann et al., 1973，有限风区）：
 *   S = S_PM·γ^Γ，Γ = exp(−(f−fp)²/(2σ²fp²))，σ = 0.07（f≤fp）/ 0.09（f>fp）
 *   教学版（与 docs/SPEC.md §13 声明一致）：保留峰增强因子 γ 与 σ 宽度，
 *   省略标准 JONSWAP 的归一化系数项；
 *   fp = 3.5·(g/U)·(gF/U²)^(−1/3)（风区 F 决定谱峰位置），
 *   α = 0.076·(gF/U²)^(−0.22)。
 *
 * 【教学简化声明】本模块是经验谱的教学实现，不是完整海洋数值模型。
 */
import { G } from '../core/constants';

/** PM 无量纲平衡度 α */
export const PM_ALPHA = 0.0081;

/** PM 谱峰频率系数：fp = 0.877·g/(2π·U) */
export const PM_PEAK_COEF = 0.877;

/** PM 谱密度 S(f)（m²·s），f 单位 Hz；f ≤ 0 或非有限返回 0 */
export function pmSpectrum(f: number, fp: number, alpha: number = PM_ALPHA): number {
  if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(fp) || fp <= 0) return 0;
  return ((alpha * G * G) / Math.pow(2 * Math.PI, 4)) * Math.pow(f, -5)
    * Math.exp(-1.25 * Math.pow(fp / f, 4));
}

/** JONSWAP 宽度参数 σ */
export function jonswapSigma(f: number, fp: number): number {
  return f <= fp ? 0.07 : 0.09;
}

/** JONSWAP 峰增强指数 Γ = exp(−(f−fp)²/(2σ²fp²)) */
export function jonswapGammaExponent(f: number, fp: number): number {
  const sigma = jonswapSigma(f, fp);
  return Math.exp(-(f - fp) * (f - fp) / (2 * sigma * sigma * fp * fp));
}

/** JONSWAP 谱密度 S(f)（m²·s）= PM 同形基谱 × γ^Γ */
export function jonswapSpectrum(
  f: number,
  fp: number,
  gamma: number,
  alpha: number,
): number {
  if (!Number.isFinite(gamma) || gamma < 1) return pmSpectrum(f, fp, alpha);
  return pmSpectrum(f, fp, alpha) * Math.pow(gamma, jonswapGammaExponent(f, fp));
}

/** PM 谱峰频率 fp（Hz），U = 19.5 m 高度等效风速（m/s） */
export function pmPeakFrequency(windSpeed: number): number {
  if (!Number.isFinite(windSpeed) || windSpeed <= 0) return 0;
  return (PM_PEAK_COEF * G) / (2 * Math.PI * windSpeed);
}

/** JONSWAP 无量纲风区 ξ = gF/U² 的 α：α = 0.076·ξ^(−0.22) */
export function jonswapAlpha(windSpeed: number, fetch: number): number {
  if (!Number.isFinite(windSpeed) || windSpeed <= 0 || !Number.isFinite(fetch) || fetch <= 0) {
    return PM_ALPHA;
  }
  const xi = (G * fetch) / (windSpeed * windSpeed);
  return 0.076 * Math.pow(xi, -0.22);
}

/** JONSWAP 谱峰频率 fp = 3.5·(g/U)·(gF/U²)^(−1/3)（Hz），风区决定峰位 */
export function jonswapPeakFrequency(windSpeed: number, fetch: number): number {
  if (!Number.isFinite(windSpeed) || windSpeed <= 0 || !Number.isFinite(fetch) || fetch <= 0) {
    return pmPeakFrequency(windSpeed);
  }
  const xi = (G * fetch) / (windSpeed * windSpeed);
  return 3.5 * (G / windSpeed) * Math.pow(xi, -1 / 3);
}

/**
 * 谱零阶矩数值积分 m0 = ∫ S(f) df（Simpson 法）。
 * 供"谱积分恢复 Hs = 4√m0"的校验与图表/报告使用；
 * 积分区间截断误差由调用方负责（推荐 [fp/20, 12·fp] 以上覆盖）。
 */
export function numericSpectralMoment(
  spectrum: (f: number) => number,
  fLo: number,
  fHi: number,
  intervals = 2000,
): number {
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fHi <= fLo) return 0;
  const n = intervals % 2 === 0 ? intervals : intervals + 1;
  const h = (fHi - fLo) / n;
  let sum = spectrum(fLo) + spectrum(fHi);
  for (let i = 1; i < n; i++) {
    const s = spectrum(fLo + i * h);
    sum += (i % 2 === 1 ? 4 : 2) * (Number.isFinite(s) ? s : 0);
  }
  return (sum * h) / 3;
}
