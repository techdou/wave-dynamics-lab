/**
 * 展示格式化（纯逻辑，可单测）
 * 全部函数对非法输入（NaN / Infinity / 负数）做防御，绝不抛错——
 * 显示层异常不应打断实验流程。
 */

/** 仿真时间 → mm:ss 或 h:mm:ss；非有限值/负值按 00:00 */
export function formatSimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 物理读数 → 固定小数位字符串；非有限值显示占位符 */
export function formatMetric(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** 大整数（风区、种子等）→ 千分位字符串；非有限值显示占位符 */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-CN');
}
