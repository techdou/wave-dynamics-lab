/**
 * 时序极值扫描 —— η(t) 图上的峰 / 谷标记。
 * 对缓冲区内样本做三点局部极值判定（离线扫描，区别于 instruments 的流式检测器）。
 * 纯函数，不依赖 DOM。
 */

export interface TimeValueSample {
  /** 仿真时间（s） */
  t: number;
  /** 波面高度 η（m）或任意标量 */
  v: number;
}

export type ExtremumMode = 'peak' | 'trough';

/**
 * 扫描局部极大（peak）或局部极小（trough）。
 * 判定：v[i-1] < v[i] ≥ v[i+1]（peak，严格上坡 + 不严格下坡，平顶取平台首点）；
 * trough 对称。首尾样本不参与判定。相邻报告间隔不小于 minIntervalSeconds（抑制毛刺）。
 * 三元组任一侧时间间隔超过 maxGapSeconds（暂停恢复 / 探针跳变造成的缺口）时跳过，
 * 防止缺口两侧样本构成伪极值。
 */
export function scanExtrema(
  samples: readonly TimeValueSample[],
  mode: ExtremumMode,
  minIntervalSeconds = 0.2,
  maxGapSeconds = 0.1,
): TimeValueSample[] {
  const out: TimeValueSample[] = [];
  if (samples.length < 3) return out;
  let lastReported: number | null = null;
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const next = samples[i + 1];
    if (!prev || !cur || !next) continue;
    if (cur.t - prev.t > maxGapSeconds || next.t - cur.t > maxGapSeconds) continue;
    const isPeak =
      mode === 'peak' && prev.v < cur.v && cur.v >= next.v;
    const isTrough =
      mode === 'trough' && prev.v > cur.v && cur.v <= next.v;
    if (!isPeak && !isTrough) continue;
    if (lastReported !== null && cur.t - lastReported < minIntervalSeconds) continue;
    out.push(cur);
    lastReported = cur.t;
  }
  return out;
}
