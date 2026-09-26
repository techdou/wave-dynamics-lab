/**
 * 色散关系模块 —— docs/SPEC.md §5.2
 * ============================================================
 * 完整色散关系：ω² = g·k·tanh(k·h)
 *   深水极限（k·h → ∞）：ω² = g·k，k = ω²/g
 *   浅水极限（k·h → 0）：ω  = k·√(g·h)，波速与频率无关（非色散）
 * 由 ω 反解 k 用牛顿迭代。注意：对固定 ω，真解 k* 同时大于两个解析极限
 * （深水极限 k_d=ω²/g 因 tanh<1 而偏小；浅水极限 k_s=ω/√(gh) 因 tanh(kh)<kh
 * 而偏小），故以 max(k_d, k_s) 为下界初值、牛顿向上收敛；
 * 迭代带越界守卫（k≤0 时折半回落），32 次上限。
 *
 * 数值守卫（浅水防护）：
 *   - h ≤ 0 或非有限 ⇒ 视为深水；
 *   - tanh 有界不溢出；sech² = 1 − tanh² ∈ [0,1] 不溢出；
 *   - ω ≤ 0 / NaN ⇒ k = 0。
 */
import { G } from '../core/constants';

/** 由角频率 ω（rad/s）反解波数 k（rad/m）；depth 单位 m，∞ = 深水 */
export function solveWaveNumber(omega: number, depth: number): number {
  if (!Number.isFinite(omega) || omega <= 0) return 0;
  const omegaSq = omega * omega;
  if (!Number.isFinite(depth) || depth <= 1e-3) return omegaSq / G; // 深水极限 + 除零守卫

  const kShallow = omega / Math.sqrt(G * depth); // 浅水极限下界
  let k = Math.max(omegaSq / G, kShallow); // 真解 ∈ [k浅, k深]，取大者为初值（从上方收敛）
  for (let i = 0; i < 32; i++) {
    const kh = k * depth;
    const th = Math.tanh(kh);
    const f = G * k * th - omegaSq;
    const df = G * (th + kh * (1 - th * th)); // d/dk [g·k·tanh(kh)]
    if (!Number.isFinite(df) || df <= 0) break;
    const step = f / df;
    const kNew = k - step;
    if (!Number.isFinite(kNew) || kNew <= 0) {
      k /= 2; // 迭代越界守卫：折半回落
      continue;
    }
    k = kNew;
    if (Math.abs(step) < 1e-12 * Math.max(1, k)) break;
  }
  return k;
}

/** 相速度 c = ω/k（m/s） */
export function phaseSpeed(omega: number, depth: number): number {
  const k = solveWaveNumber(omega, depth);
  return k > 1e-12 ? omega / k : 0;
}

/** 群速度 c_g = c·(1/2 + kh/sinh(2kh))（m/s）；深水 c/2，浅水 c */
export function groupSpeed(omega: number, depth: number): number {
  const k = solveWaveNumber(omega, depth);
  if (k <= 1e-12) return 0;
  const c = omega / k;
  if (!Number.isFinite(depth) || depth <= 1e-3) return c / 2;
  const kh = k * depth;
  if (kh > 350) return c / 2; // sinh 溢出守卫：kh 大时已处深水极限
  return c * (0.5 + kh / Math.sinh(2 * kh));
}

/** 由 ω 反解波长 λ = 2π/k（m） */
export function wavelengthFromOmega(omega: number, depth: number): number {
  const k = solveWaveNumber(omega, depth);
  return k > 1e-12 ? (2 * Math.PI) / k : 0;
}
