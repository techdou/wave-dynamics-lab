/**
 * 波分量 → 离散谱能量换算 —— S(f) 谱图 stem 数据。
 * 将 waveField.components() 的时域分量换算为可与理论谱 S(f)（m²·s）同轴比较的
 * 离散谱密度估计。纯函数，不依赖 DOM。
 */
import type { WaveComponent } from '../core/types';

export interface SpectralStemPoint {
  /** 分量频率 f = ω/2π（Hz） */
  f: number;
  /** 分量振幅 a（m） */
  amplitude: number;
  /** 离散谱密度近似 a²/(2Δf)（m²·s）；Δf 为分量频距中位数 */
  energyDensity: number;
}

const EPS_AMP = 1e-9;
const EPS_FREQ = 1e-6;
/** 频距不可估（分量 < 2 个）时的名义带宽（Hz），仅保证 stem 可画 */
const NOMINAL_BANDWIDTH = 1 / 32;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return sorted.length % 2 === 1 ? (b as number) : ((a as number) + (b as number)) / 2;
}

/**
 * 分量离散谱能量：
 *   1. 过滤零振幅 / 零频率分量，按频率升序；
 *   2. Δf 取相邻频距的中位数（骨架离散为常数 Δf，中位数即为该常数）；
 *   3. 每分量能量 a²/2 摊到频带得能量密度 a²/(2Δf)。
 * 单分量 / 等频退化时使用名义带宽，stem 高度 = a²/(2·NOMINAL_BANDWIDTH)。
 */
export function componentEnergyStems(
  comps: readonly WaveComponent[],
): SpectralStemPoint[] {
  const valid = comps
    .filter((c) => c.amp > EPS_AMP && c.omega > EPS_FREQ)
    .map((c) => ({ f: c.omega / (2 * Math.PI), amplitude: c.amp }))
    .sort((a, b) => a.f - b.f);

  let deltaF = NOMINAL_BANDWIDTH;
  if (valid.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const cur = valid[i];
      if (prev && cur) gaps.push(Math.abs(cur.f - prev.f));
    }
    const med = median(gaps);
    if (med > 1e-9) deltaF = med;
  }

  return valid.map((p) => ({
    f: p.f,
    amplitude: p.amplitude,
    energyDensity: (p.amplitude * p.amplitude) / (2 * deltaF),
  }));
}
