/**
 * 风浪成长教学模型 —— SPM/JONSWAP 量纲一致成长律
 * ============================================================
 * 【教学简化声明】这是面向课堂的简化经验模型（SPM/JONSWAP 幂律 + 充分发展封顶），
 * 不是完整的海浪数值预报模型（无第三代谱模式 WAM/SWAN 的能量平衡方程）。
 * 完整推导与适用范围见 src/physics/MODELS.md。
 *
 * 深水无量纲能量/频率成长律（JONSWAP 观测拟合，SI 单位）：
 *   风区限制（ξ = gF/U²）：
 *     ε ≡ g·Hs/U² = 0.0016·ξ^(1/2)      （→ Hs = 0.0016·(U²/g)·ξ^(1/2)）
 *     g·Tp/U = (1/3.5)·ξ^(1/3)          （→ Tp = (U/(3.5g))·ξ^(1/3)，等价 fp = 3.5(g/U)ξ^(−1/3)）
 *   风时限制：用"等效风区"折算——深水峰群速 c_g(fp) = g/(4π·fp)，
 *     令 F_eq = c_g·t 自洽求解得 ξ_dur = (ξ_t/(14π))^(3/2)，ξ_t = g·t/U；
 *     再代入同一组风区幂律（系数见 DURATION_EQ_FETCH_COEF 推导注释）。
 *   充分发展封顶（PM）：Hs_FD = 0.21·U²/g，Tp_FD = 2π·U/(0.877·g)。
 *
 * 取舍规则（需求要求）：Hs 取风时限制与风区限制的较小者（能量小者），Tp 跟随所在分支；
 * 再与充分发展值取小封顶；最后按项目红线 Hs ∈ [0,10] m 硬封顶。
 */
import { G } from '../core/constants';

/** JONSWAP 能量成长系数：ε = 0.0016·ξ^(1/2) */
export const JONSWAP_HS_COEF = 0.0016;
/** JONSWAP 峰频率系数：fp = 3.5·(g/U)·ξ^(−1/3) */
export const JONSWAP_FP_COEF = 3.5;

/**
 * 风时→等效风区换算常数 14π。
 * 推导：F_eq = c_g·t，c_g = g/(4π·fp)，fp = 3.5(g/U)ξ^(−1/3)
 *   ⇒ ξ_F = (ξ_t/(14π))^(3/2)，ξ_t = g·t/U。
 * 该常数使风时分支与风区分支在"波浪传播一个峰群速×风时"处自洽衔接；
 * 与 SPM 经典曲线量级一致（教学近似）。
 */
export const DURATION_EQ_FETCH_COEF = 14 * Math.PI;

/** 充分发展（PM）能量系数：Hs_FD = 0.21·U²/g */
export const FULLY_DEVELOPED_HS_COEF = 0.21;
/** 充分发展（PM）峰周期系数：Tp_FD = (2π/0.877)·U/g ≈ 0.730·U */
export const FULLY_DEVELOPED_TP_COEF = (2 * Math.PI) / 0.877;

/** 项目红线：Hs 硬上限（m） */
export const HS_HARD_CAP = 10;

/** 单个成长分支结果（SI） */
export interface GrowthBranch {
  hs: number;
  tp: number;
}

export type GrowthLimiting = 'calm' | 'duration' | 'fetch' | 'fully-developed';

export interface WindGrowthResult extends GrowthBranch {
  limiting: GrowthLimiting;
}

/** 风区限制分支（ξ = gF/U² 幂律） */
export function fetchLimitedSea(windSpeed: number, fetch: number): GrowthBranch {
  const u = Math.max(windSpeed, 1e-6);
  const xi = (G * fetch) / (u * u);
  return {
    hs: JONSWAP_HS_COEF * ((u * u) / G) * Math.sqrt(xi),
    tp: (u / (JONSWAP_FP_COEF * G)) * Math.cbrt(xi),
  };
}

/** 风时限制分支（等效风区 ξ_dur = (ξ_t/(14π))^(3/2) 幂律）；t 单位秒 */
export function durationLimitedSea(windSpeed: number, durationSeconds: number): GrowthBranch {
  const u = Math.max(windSpeed, 1e-6);
  const xiT = (G * durationSeconds) / u;
  const xi = Math.pow(xiT / DURATION_EQ_FETCH_COEF, 1.5);
  return {
    hs: JONSWAP_HS_COEF * ((u * u) / G) * Math.sqrt(xi),
    tp: (u / (JONSWAP_FP_COEF * G)) * Math.cbrt(xi),
  };
}

/** 充分发展封顶（PM 经典关系） */
export function fullyDevelopedSea(windSpeed: number): GrowthBranch {
  return {
    hs: FULLY_DEVELOPED_HS_COEF * ((windSpeed * windSpeed) / G),
    tp: (FULLY_DEVELOPED_TP_COEF * windSpeed) / G,
  };
}

/**
 * 综合成长模型：风速 + 风时（min）→ Hs / Tp。
 * @param windSpeed      风速 m/s（clamp [0,30]，NaN→0）
 * @param durationMin    风时 min（clamp [0,60]，NaN→0）
 * @param fetch          风区 m（实验一无滑块，教学固定值；clamp [1e3,1e6]）
 * U < 0.3 或风时 = 0 ⇒ 平静（hs = tp = 0，与 SPEC §9.1 形态连续谱一致）。
 */
export function windGrowth(
  windSpeed: number,
  durationMin: number,
  fetch: number,
): WindGrowthResult {
  const u = clampNum(windSpeed, 0, 30);
  const tMin = clampNum(durationMin, 0, 60);
  const f = clampNum(fetch, 1e3, 1e6);
  if (u < 0.3 || tMin <= 0) return { hs: 0, tp: 0, limiting: 'calm' };

  const dur = durationLimitedSea(u, tMin * 60);
  const fet = fetchLimitedSea(u, f);
  let branch: GrowthBranch;
  let limiting: GrowthLimiting;
  if (fet.hs <= dur.hs) {
    branch = fet;
    limiting = 'fetch';
  } else {
    branch = dur;
    limiting = 'duration';
  }

  const fd = fullyDevelopedSea(u);
  let hs = Math.min(branch.hs, fd.hs);
  let tp = Math.min(branch.tp, fd.tp);
  if (fd.hs < branch.hs || fd.tp < branch.tp) limiting = 'fully-developed';

  hs = clampNum(hs, 0, HS_HARD_CAP); // 项目红线：Hs ∈ [0,10] m 硬封顶
  tp = clampNum(tp, 0.1, 25);
  return { hs, tp, limiting };
}

/** 通用数值守卫：NaN → 下界；±∞ → 边界 */
export function clampNum(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
