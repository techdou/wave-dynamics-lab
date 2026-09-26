/**
 * 图表数值工具 —— 刻度取整 / 时间步长选择 / 数值格式化。
 * 纯函数，不依赖 DOM。
 */

const NICE_STEPS = [1, 1.5, 2, 2.5, 5, 10] as const;

/** 向上取到 1/1.5/2/2.5/5/10 × 10^n 的"好看"刻度；非法输入返回 1 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  for (const step of NICE_STEPS) {
    if (step * base >= value - 1e-12) return step * base;
  }
  return 10 * base;
}

/** 给定窗口时长选出时间刻度步长（秒），刻度数 ≤ maxTicks */
export function niceTimeStep(windowSeconds: number, maxTicks = 8): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of candidates) {
    if (windowSeconds / step <= maxTicks) return step;
  }
  return 1200;
}

/** 定点小数格式化，规范化 -0 */
export function formatFixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const out = value.toFixed(digits);
  return out === '-' + (0).toFixed(digits) ? (0).toFixed(digits) : out;
}

/** 带显式正号的格式化（读数用，等宽字体下对齐友好） */
export function formatSigned(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return sign + formatFixed(value, digits);
}

/** 百分比格式化；null（理论值缺失 / 为 0，不可比较）显示破折号 */
export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  return `${formatFixed(percent, 1)}%`;
}

/**
 * 百分误差 = |measured − theoretical| / |theoretical| × 100。
 * 理论值缺失、非有限或绝对值过小（< 1e-12，如静水平态）时返回 null（不可比）。
 */
export function percentError(measured: number, theoretical: number): number | null {
  if (!Number.isFinite(measured) || !Number.isFinite(theoretical)) return null;
  if (Math.abs(theoretical) < 1e-12) return null;
  return (Math.abs(measured - theoretical) / Math.abs(theoretical)) * 100;
}
