/**
 * instruments 内部小工具 —— 与 src/viz/chartMath 保持同语义的纯函数
 * （架构铁律：跨 feature 运行时零 import，故本模块自带一份，不 import viz）。
 */

/** 百分误差 = |measured − theoretical| / |theoretical| × 100；理论值缺失/为 0 时 null（不可比） */
export function percentError(measured: number, theoretical: number): number | null {
  if (!Number.isFinite(measured) || !Number.isFinite(theoretical)) return null;
  if (Math.abs(theoretical) < 1e-12) return null;
  return (Math.abs(measured - theoretical) / Math.abs(theoretical)) * 100;
}

/** 读数格式化：非有限值显示破折号 */
export function formatValue(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** 百分比显示：null 显示破折号（mystery 模式理论值被隐藏时使用） */
export function formatPercentValue(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

let idCounter = 0;
/** 测量记录 id：优先 crypto.randomUUID，node/旧环境退化为计数器 */
export function makeRecordId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return `meas-${c.randomUUID()}`;
  }
  idCounter += 1;
  return `meas-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
