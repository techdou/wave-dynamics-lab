/**
 * 实验二 · 双造波机叠加干涉观测量数学（纯函数）。
 * 判定公式与 docs/SPEC.md §6.5 任务二~五一致，供控制器 observables
 * 与任务系统复现使用。
 */
import type { InterferenceExperimentParams } from '../core/types';

/** 任务四拍现象判定带：|T_A − T_B| / T̄ ∈ [0.1, 0.3] */
export const BEATING_BAND_MIN = 0.1;
export const BEATING_BAND_MAX = 0.3;

/**
 * 相位差 (φ_B − φ_A)，wrap 到 (−180, 180]（度）。
 * ≈0 相长；|Δφ|≈180 且振幅相等时相消。
 */
export function phaseDifferenceDeg(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** 两列波传播方向夹角（度），值域 [0, 180]；任务五格状波带 60°–120° */
export function angleDifferenceDeg(a: number, b: number): number {
  return Math.abs(phaseDifferenceDeg(a, b));
}

/** 相对周期差 |T_A − T_B| / T̄（无量纲） */
export function relativePeriodDifference(tA: number, tB: number): number {
  const mean = (tA + tB) / 2;
  return mean > 0 ? Math.abs(tA - tB) / mean : 0;
}

/** 是否落在任务四拍判定带 [0.1, 0.3] */
export function isInBeatingBand(tA: number, tB: number): boolean {
  const r = relativePeriodDifference(tA, tB);
  return r >= BEATING_BAND_MIN && r <= BEATING_BAND_MAX;
}

/**
 * 拍周期（s）：1 / |f_B − f_A|，f = 1/T——即包络 |cos(πΔf·t)| 相邻两次
 * 极大之间的间隔，学生用秒表可测，与任务四判定（judges）与秒表拍周期
 * 估计器（beatMeter）同一口径。周期相等时无拍，返回 Infinity。
 */
export function beatPeriodSeconds(tA: number, tB: number): number {
  const df = Math.abs(1 / tB - 1 / tA);
  return df > 1e-12 ? 1 / df : Number.POSITIVE_INFINITY;
}

/**
 * 同向叠加振幅上下界（m）：输入波高 H，物理振幅 a = H/2。
 * 相长上界 = a_A + a_B；相消下界 = |a_A − a_B|。
 */
export function superposedAmplitudes(
  hA: number,
  hB: number,
): { max: number; min: number } {
  return { max: (hA + hB) / 2, min: Math.abs(hA - hB) / 2 };
}

/** 从实验二参数中取双机观测量所需的标量组（供控制器组装） */
export function interferenceScalars(p: InterferenceExperimentParams): {
  phaseDiffDeg: number;
  angleDiffDeg: number;
  relativePeriodDiff: number;
  inBeatingBand: boolean;
  beatPeriod: number;
  maxAmp: number;
  minAmp: number;
} {
  const bounds = superposedAmplitudes(p.makerA.amplitude, p.makerB.amplitude);
  return {
    phaseDiffDeg: phaseDifferenceDeg(p.makerA.phase, p.makerB.phase),
    angleDiffDeg: angleDifferenceDeg(p.makerA.angle, p.makerB.angle),
    relativePeriodDiff: relativePeriodDifference(
      p.makerA.period,
      p.makerB.period,
    ),
    inBeatingBand: isInBeatingBand(p.makerA.period, p.makerB.period),
    beatPeriod: beatPeriodSeconds(
      p.makerA.period,
      p.makerB.period,
    ),
    maxAmp: bounds.max,
    minAmp: bounds.min,
  };
}
