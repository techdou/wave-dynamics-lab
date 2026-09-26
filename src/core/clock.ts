/**
 * 仿真时钟 —— docs/SPEC.md §5.3
 * 固定步长推进（accumulator 模式），支持暂停/继续、1x/2x 倍速、重置。
 * 渲染循环每帧调用一次 advance(真实帧间隔秒)，时钟保证物理以固定步长演化。
 * 本文件为定稿契约，只允许修 bug，不允许改签名。
 */
import { DEFAULT_STEP_SECONDS } from './constants';
import type { TimeScale, Unsubscribe } from './types';

export interface SimClockOptions {
  /** 固定仿真步长（s），默认 1/60 */
  stepSeconds?: number;
  /** 单帧最大步数上限（防"螺旋追赶"卡死），默认 8 */
  maxStepsPerFrame?: number;
  initialTime?: number;
}

export interface SimClock {
  readonly stepSeconds: number;
  /** 当前仿真时间（s） */
  time(): number;
  isPaused(): boolean;
  scale(): TimeScale;
  pause(): void;
  resume(): void;
  /** 切换暂停态，返回切换后是否暂停 */
  togglePause(): boolean;
  setScale(scale: TimeScale): void;
  /** 仿真时间归零、清空累加器；暂停态与倍速保持不变 */
  reset(): void;
  /**
   * 驱动推进：真实帧间隔（s）× 倍速 → 按固定步长逐步推进，
   * 每推进一步触发一次 onStep 回调。返回本帧实际推进的仿真秒数（暂停时为 0）。
   */
  advance(realDeltaSeconds: number): number;
  /** 每个固定仿真步后的回调；返回退订函数 */
  onStep(cb: (simTime: number) => void): Unsubscribe;
}

export function createSimClock(options: SimClockOptions = {}): SimClock {
  const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS;
  const maxStepsPerFrame = options.maxStepsPerFrame ?? 8;
  let simTime = options.initialTime ?? 0;
  let accumulator = 0;
  let paused = false;
  let scale: TimeScale = 1;
  const stepCallbacks = new Set<(simTime: number) => void>();

  const clock: SimClock = {
    stepSeconds,
    time: () => simTime,
    isPaused: () => paused,
    scale: () => scale,

    pause() {
      paused = true;
    },

    resume() {
      paused = false;
    },

    togglePause() {
      paused = !paused;
      return paused;
    },

    setScale(next) {
      scale = next;
    },

    reset() {
      simTime = 0;
      accumulator = 0;
    },

    advance(realDeltaSeconds) {
      if (paused) return 0;
      const delta = Math.max(0, realDeltaSeconds) * scale;
      accumulator += delta;
      let advanced = 0;
      let steps = 0;
      while (accumulator >= stepSeconds && steps < maxStepsPerFrame) {
        accumulator -= stepSeconds;
        simTime += stepSeconds;
        advanced += stepSeconds;
        steps += 1;
        for (const cb of [...stepCallbacks]) cb(simTime);
      }
      // 超过单帧上限仍有积压：丢弃积压，防止长时间低帧率后螺旋追赶
      if (accumulator >= stepSeconds) accumulator = 0;
      return advanced;
    },

    onStep(cb) {
      stepCallbacks.add(cb);
      return () => {
        stepCallbacks.delete(cb);
      };
    },
  };

  return clock;
}
