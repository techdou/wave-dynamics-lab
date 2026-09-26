/**
 * 流式波峰 / 波谷时刻检测器 —— 秒表与波高尺的核心（SPEC §7.4）。
 * 对 60Hz 固定仿真步喂入的 η 序列做三点局部极值判定 + 抛物线插值细化峰时刻。
 * 暂停时无新样本喂入 → 不会误检；2x 倍速下仿真步长仍为 1/60 s → 采样密度不变，
 * 检测行为与 1x 完全一致。纯逻辑，不依赖 DOM / clock / store。
 */

export interface ExtremumSample {
  /** 仿真时间（s） */
  t: number;
  /** 波面高度 η（m） */
  eta: number;
}

export interface StreamExtremaDetector {
  /** 喂入一个采样点；检测到极值时返回插值后的极值时刻，否则 null */
  feed(sample: ExtremumSample): ExtremumSample | null;
  /** 最近一次报告的极值（含插值时刻），无则 null */
  lastReported(): ExtremumSample | null;
  reset(): void;
}

/**
 * mode='peak' 检测波峰经过，'trough' 检测波谷经过。
 * minIntervalSeconds：相邻两次报告的最小时间间隔（过滤高频毛刺双峰），
 * 默认 0.2 s —— 小于最短可设波周期 0.5 s 的一半，不会吞掉真实相邻波峰。
 * maxGapSeconds：采样时间间隙阈值（默认 0.05 s，约 3 个 60Hz 步）。
 * 暂停恢复 / 探针跳变产生时间缺口时丢弃历史重新积累，
 * 否则缺口两侧样本会构成伪极值（数值上恰好高于两侧邻点）。
 */
export function createStreamExtremaDetector(
  mode: 'peak' | 'trough',
  minIntervalSeconds = 0.2,
  maxGapSeconds = 0.05,
): StreamExtremaDetector {
  let prev: ExtremumSample | null = null; // 倒数第二个点
  let cur: ExtremumSample | null = null; // 最新点
  let lastReport: ExtremumSample | null = null;

  return {
    feed(sample: ExtremumSample): ExtremumSample | null {
      // 时间间隙：丢弃历史，从新点重新积累三点窗口
      if (cur && sample.t - cur.t > maxGapSeconds) {
        prev = null;
        cur = { ...sample };
        return null;
      }
      const p2 = prev;
      const p1 = cur;
      prev = cur;
      cur = { ...sample };
      if (!p2 || !p1) return null;

      const risingInto = mode === 'peak' ? p2.eta < p1.eta : p2.eta > p1.eta;
      const fallingOut = mode === 'peak' ? p1.eta >= cur.eta : p1.eta <= cur.eta;
      if (!risingInto || !fallingOut) return null;

      if (lastReport !== null && p1.t - lastReport.t < minIntervalSeconds) {
        return null;
      }

      // 抛物线插值细化极值时刻：以 p1 为顶点的三点抛物线顶点偏移
      const denom = p2.eta - 2 * p1.eta + cur.eta;
      const dtStep = (cur.t - p2.t) / 2;
      const offset = Math.abs(denom) > 1e-15 ? ((p2.eta - cur.eta) / (2 * denom)) * dtStep : 0;
      const tExt = p1.t + offset;
      const report: ExtremumSample = { t: tExt, eta: p1.eta };
      lastReport = report;
      return report;
    },

    lastReported(): ExtremumSample | null {
      return lastReport;
    },

    reset(): void {
      prev = null;
      cur = null;
      // lastReport 保留：跨探针跳变后仍需 minInterval 保护
    },
  };
}
