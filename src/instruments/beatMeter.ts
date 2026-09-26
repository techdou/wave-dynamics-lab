/**
 * 拍周期估计器（纯逻辑）—— 任务四「拍」配套（SPEC §10 测量键 beatingPeriod）。
 *
 * 背景：秒表经波峰检测器测得的是载波周期（period 键）；拍周期 = 包络相邻两次
 * 最大振幅的时间差。拍现象下载体波仍以载波频率经过探针，但每个波峰的高度
 * 沿拍包络起落——把峰检测器逐峰报告的 (t, η) 序列看作包络的采样，对其取
 * 「显著局部极大」，相邻两个显著极大的时间差即拍周期估计。
 *
 * 两相状态机（防同一下降坡被反复确认为新极大）：
 *  1. 无候选相：追踪谷值；峰相对谷显著抬升（抬升量 ≥ prominenceRatio × 峰高）
 *     时建立候选极大，转入候选相；
 *  2. 候选相：更高峰替换候选；回落谷比候选低出 ≥ prominenceRatio × 候选高时
 *     确认为一次显著包络极大——与上一个确认极大的间隔 ≥ minSeparationSeconds
 *     即产出拍周期估计，随后回到无候选相（以当前谷为下一轮上升参照）。
 *
 * 突出度阈值 0.25 的依据：任务四要求的包络对比 ≥ 2:1 对应突出度 ≥ 1/3，0.25 留余量；
 * 常幅海况峰高几乎不变，永远达不到阈值 → 不产出拍周期，而非伪造读数。
 * minSeparationSeconds 默认 5 s：远大于载波周期、远小于失谐带宽 [0.1,0.3] 内
 * 最短拍周期 ≈13 s，用于过滤毛刺。
 *
 * 纯逻辑，不依赖 DOM / clock / store；随机无关（逐峰确定性判定）。
 */

export interface EnvelopeSample {
  /** 仿真时间（s）——即波峰检测器插值后的极值时刻 */
  t: number;
  /** 该波峰的 η（m）——拍现象下沿包络起落 */
  eta: number;
}

export interface BeatMeter {
  /** 逐峰喂入（仅秒表计时会话期间调用） */
  feed(sample: EnvelopeSample): void;
  /** 最近一次估计的拍周期（s）；样本不足以判定显著包络极大对时为 null */
  periodSeconds(): number | null;
  /** 清空回无估计状态（新计时会话 / 复位时调用） */
  reset(): void;
}

export function createBeatMeter(
  minSeparationSeconds = 5,
  prominenceRatio = 0.25,
): BeatMeter {
  /** 上一个已确认的包络极大（时间/高度） */
  let envMax: EnvelopeSample | null = null;
  /** 当前候选极大；null = 无候选相（追踪谷值等待显著抬升） */
  let candidate: EnvelopeSample | null = null;
  /** 参照谷：无候选相为最近谷值；候选相为候选建立以来的最深回落谷 */
  let trough = Number.POSITIVE_INFINITY;
  let lastPeriod: number | null = null;

  return {
    feed(sample: EnvelopeSample): void {
      if (!Number.isFinite(sample.t) || !Number.isFinite(sample.eta)) return;
      if (candidate === null) {
        // 无候选相：谷值下探；显著抬升（η − trough ≥ p·η ⇔ trough ≤ (1−p)·η）建立候选
        if (sample.eta < trough) {
          trough = sample.eta;
          return;
        }
        if (trough < Number.POSITIVE_INFINITY && sample.eta - trough >= prominenceRatio * sample.eta) {
          candidate = { ...sample };
          trough = sample.eta;
        }
        return;
      }
      if (sample.eta > candidate.eta) {
        // 仍在上升（或创新高）：候选更新
        candidate = { ...sample };
        trough = sample.eta;
        return;
      }
      // 候选相回落：谷值下探，谷足够深时确认候选为一次显著包络极大
      if (sample.eta < trough) trough = sample.eta;
      if (candidate.eta - trough < prominenceRatio * candidate.eta) return;
      if (envMax !== null) {
        const dt = candidate.t - envMax.t;
        // 间隔过滤：过近视为同一包络脊的毛刺，不产出拍周期
        if (dt >= minSeparationSeconds) lastPeriod = dt;
      }
      envMax = candidate;
      candidate = null;
      // 当前回落谷即下一轮上升参照
    },

    periodSeconds(): number | null {
      return lastPeriod;
    },

    reset(): void {
      envMax = null;
      candidate = null;
      trough = Number.POSITIVE_INFINITY;
      lastPeriod = null;
    },
  };
}
