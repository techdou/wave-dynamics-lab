/**
 * 波高尺逻辑（纯状态机）—— SPEC §7.4 / §10：
 * 学生在指定测量点（探针）依次拾取一个波峰与其相邻波谷，波高 = η峰 − η谷。
 * 「相邻」约束体现为：波谷时刻必须晚于已锁定的波峰时刻；
 * 拾取波谷时若最近检测谷不满足时序，则进入 awaiting-trough，由后续新谷自动完成。
 */
import type { ExtremumSample } from './peakDetector';

export type WaveRulerPhase = 'idle' | 'awaiting-trough' | 'complete';

export interface WaveRulerState {
  phase: WaveRulerPhase;
  peak: ExtremumSample | null;
  trough: ExtremumSample | null;
  /** 波高 = η峰 − η谷（m）；complete 态有效 */
  waveHeight: number | null;
}

export type PickTroughResult =
  | 'completed'
  | 'awaiting'
  | /** 无可用谷样本 */ 'no-sample'
  | /** 谷时刻不晚于已锁定峰（非相邻） */ 'stale';

export interface WaveRulerLogic {
  readonly state: WaveRulerState;
  /** 锁定一个波峰样本；null = 检测器还没有波峰，返回 false */
  pickPeak(sample: ExtremumSample | null): boolean;
  /** 拾取波谷 */
  pickTrough(sample: ExtremumSample | null): PickTroughResult;
  /** awaiting-trough 态下喂入新谷：谷时刻晚于峰则完成测量 */
  feedTrough(sample: ExtremumSample): boolean;
  /** 一次测量完成/作废后回到 idle */
  reset(): void;
}

export function createWaveRulerLogic(): WaveRulerLogic {
  let peak: ExtremumSample | null = null;
  let trough: ExtremumSample | null = null;
  let phase: WaveRulerPhase = 'idle';

  function completeIfValid(candidate: ExtremumSample): boolean {
    if (!peak || candidate.t <= peak.t) return false;
    trough = candidate;
    phase = 'complete';
    return true;
  }

  return {
    get state(): WaveRulerState {
      return {
        phase,
        peak,
        trough,
        waveHeight:
          peak && trough ? Number((peak.eta - trough.eta).toFixed(6)) : null,
      };
    },

    pickPeak(sample: ExtremumSample | null): boolean {
      if (!sample) return false;
      // 重新选峰：作废上一轮
      peak = sample;
      trough = null;
      phase = 'awaiting-trough';
      return true;
    },

    pickTrough(sample: ExtremumSample | null): PickTroughResult {
      if (!peak) return 'stale';
      if (!sample) return 'no-sample';
      if (sample.t <= peak.t) return 'stale';
      return completeIfValid(sample) ? 'completed' : 'stale';
    },

    feedTrough(sample: ExtremumSample): boolean {
      if (phase !== 'awaiting-trough' || !peak) return false;
      return completeIfValid(sample);
    },

    reset(): void {
      peak = null;
      trough = null;
      phase = 'idle';
    },
  };
}
