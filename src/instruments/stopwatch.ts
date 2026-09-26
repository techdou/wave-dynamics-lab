/**
 * 秒表逻辑（纯状态机）—— SPEC §7.4 / §10：
 * 开始 → 等待连续 N 个波峰经过探针 → 自动停止；
 * 周期 = (t_N − t_1)/(N − 1)，即 N 个波峰之间 N−1 个完整周期。
 * 波峰时刻由 StreamExtremaDetector 喂入；暂停时不产生新峰 → 稳定。
 */

export type StopwatchPhase = 'idle' | 'running' | 'finished';

export interface StopwatchReading {
  /** 参与计算的波峰时刻（升序，长度 = usedPeaks） */
  peakTimes: readonly number[];
  /** 周期估计（s） */
  periodSeconds: number;
  usedPeaks: number;
}

export interface StopwatchLogic {
  readonly phase: StopwatchPhase;
  readonly targetPeaks: number;
  readonly capturedCount: number;
  readonly reading: StopwatchReading | null;
  /** 开始 / 重新开始；targetPeaks 会被夹到 [2, 50] */
  start(targetPeaks: number): void;
  /** 每检测到一个波峰时刻调用；返回 {count, finished} */
  onPeak(t: number): { count: number; finished: boolean };
  /** 提前手动停止：已捕获 ≥2 峰则产出读数，否则回到 idle 且无读数 */
  stopManual(): StopwatchReading | null;
  /** 清空回 idle（保留 targetPeaks 便于重测） */
  reset(): void;
}

export function createStopwatchLogic(): StopwatchLogic {
  let phase: StopwatchPhase = 'idle';
  let target = 3;
  let peaks: number[] = [];
  let reading: StopwatchReading | null = null;

  function finish(): void {
    if (peaks.length >= 2) {
      const first = peaks[0] as number;
      const last = peaks[peaks.length - 1] as number;
      reading = {
        peakTimes: [...peaks],
        periodSeconds: (last - first) / (peaks.length - 1),
        usedPeaks: peaks.length,
      };
    } else {
      reading = null;
    }
    phase = 'finished';
  }

  return {
    get phase(): StopwatchPhase {
      return phase;
    },
    get targetPeaks(): number {
      return target;
    },
    get capturedCount(): number {
      return peaks.length;
    },
    get reading(): StopwatchReading | null {
      return reading;
    },

    start(nextTarget: number): void {
      target = Math.min(50, Math.max(2, Math.floor(nextTarget)));
      peaks = [];
      reading = null;
      phase = 'running';
    },

    onPeak(t: number): { count: number; finished: boolean } {
      if (phase !== 'running') return { count: peaks.length, finished: false };
      // 防御：重复/倒退时刻不计数
      const last = peaks.length > 0 ? peaks[peaks.length - 1] : undefined;
      if (last !== undefined && t <= last) return { count: peaks.length, finished: false };
      peaks.push(t);
      if (peaks.length >= target) {
        finish();
        return { count: peaks.length, finished: true };
      }
      return { count: peaks.length, finished: false };
    },

    stopManual(): StopwatchReading | null {
      if (phase !== 'running') return reading;
      finish();
      return reading;
    },

    reset(): void {
      phase = 'idle';
      peaks = [];
      reading = null;
    },
  };
}
