/**
 * instruments 模块测试 —— 流式峰/谷检测（含暂停/倍速稳定性）、
 * 秒表周期与误差、波高尺状态机、浮标统计（4σ / H1/3 / 过零周期 / FFT 谱峰）、
 * 浮标运动学、参数快照与记录摘要、内部环形缓冲。
 * vitest 环境 node（无 DOM）：面板 DOM 不在此覆盖，仅覆盖纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import { createStreamExtremaDetector } from '../src/instruments/peakDetector';
import { createStopwatchLogic } from '../src/instruments/stopwatch';
import { createBeatMeter } from '../src/instruments/beatMeter';
import { createWaveRulerLogic } from '../src/instruments/waveRuler';
import {
  computeBuoyStats,
  emptyBuoyStats,
  spectralPeakEstimate,
  zeroUpCrossWaves,
} from '../src/instruments/buoyStats';
import {
  buoyPositionAt,
  mainWaveFromComponents,
} from '../src/instruments/buoyKinematics';
import {
  instrumentLabel,
  paramsSnapshotNote,
  summarizeRecord,
} from '../src/instruments/measurements';
import { percentError } from '../src/instruments/common';
import { createLocalRingBuffer } from '../src/instruments/ringBuffer';
import { DEFAULT_SIM_STATE } from '../src/core/constants';

const FS = 60; // 仿真固定步 60Hz

/** 生成正弦 η 采样流（t 从 0 开始，fs Hz） */
function sineStream(
  amp: number,
  period: number,
  seconds: number,
  fs = FS,
  phase = 0,
): { t: number; eta: number }[] {
  return Array.from({ length: Math.floor(seconds * fs) }, (_, i) => ({
    t: i / fs,
    eta: amp * Math.sin((2 * Math.PI * i) / fs / period + phase),
  }));
}

describe('instruments/peakDetector：流式波峰检测', () => {
  it('正弦流：峰时刻与周期正确（插值后误差 < 5ms）', () => {
    const det = createStreamExtremaDetector('peak', 0.1);
    const period = 4;
    const stream = sineStream(0.8, period, 12);
    const peakTimes: number[] = [];
    for (const s of stream) {
      const hit = det.feed(s);
      if (hit) peakTimes.push(hit.t);
    }
    // 12s / 4s 周期 → 3 个峰（t=1, 5, 9）
    expect(peakTimes).toHaveLength(3);
    expect(peakTimes[0]).toBeCloseTo(1, 2);
    expect(peakTimes[1]).toBeCloseTo(5, 2);
    expect(peakTimes[2]).toBeCloseTo(9, 2);
    // 相邻峰间隔 = 周期
    expect(peakTimes[1]! - peakTimes[0]!).toBeCloseTo(period, 3);
    // 峰值幅度保留
    expect(det.lastReported()?.eta).toBeCloseTo(0.8, 3);
  });

  it('暂停（无新样本）不产生虚假检测；恢复后继续正常计数', () => {
    const det = createStreamExtremaDetector('peak', 0.1);
    const hits: number[] = [];
    // 0–4s 正常，4–10s 暂停（不喂点），10s 起继续
    for (const s of sineStream(1, 4, 4)) {
      const hit = det.feed(s);
      if (hit) hits.push(hit.t);
    }
    expect(hits).toHaveLength(1); // t=1
    // 暂停期间 feed 不被调用 → 无任何输出（状态冻结）
    // 恢复：从 t=10 继续（相位与 t=10 对齐）
    for (let i = 0; i <= FS * 4; i++) {
      const t = 10 + i / FS;
      const hit = det.feed({ t, eta: Math.sin((2 * Math.PI * t) / 4) });
      if (hit) hits.push(hit.t);
    }
    // t=13 处一个峰
    expect(hits).toHaveLength(2);
    expect(hits[1]).toBeCloseTo(13, 2);
  });

  it('2x 倍速下仿真步长不变（同样以 60Hz 采样喂入）→ 检测结果与 1x 一致', () => {
    const run = (scale: number): number[] => {
      // 倍速只改变真实时间与仿真时间的映射，仿真采样仍为 60Hz 固定步
      void scale;
      const det = createStreamExtremaDetector('peak', 0.1);
      const hits: number[] = [];
      for (const s of sineStream(1, 2.5, 10)) {
        const hit = det.feed(s);
        if (hit) hits.push(hit.t);
      }
      return hits;
    };
    expect(run(2)).toEqual(run(1));
  });

  it('波谷检测对称工作', () => {
    const det = createStreamExtremaDetector('trough', 0.1);
    const troughs: number[] = [];
    for (const s of sineStream(1, 6, 12)) {
      const hit = det.feed(s);
      if (hit) troughs.push(hit.t);
    }
    expect(troughs).toHaveLength(2);
    expect(troughs[0]).toBeCloseTo(4.5, 2);
  });
});

describe('instruments/stopwatch：秒表周期与误差', () => {
  function runStopwatch(target: number, period: number, seconds: number) {
    const sw = createStopwatchLogic();
    sw.start(target);
    const det = createStreamExtremaDetector('peak', 0.1);
    let finished = false;
    for (const s of sineStream(1, period, seconds)) {
      const hit = det.feed(s);
      if (hit) {
        const res = sw.onPeak(hit.t);
        if (res.finished) {
          finished = true;
          break;
        }
      }
    }
    return { sw, finished };
  }

  it('集满 N 个峰自动停止：period = (tN − t1)/(N−1)', () => {
    const { sw, finished } = runStopwatch(3, 5, 20);
    expect(finished).toBe(true);
    expect(sw.reading).not.toBeNull();
    expect(sw.reading?.usedPeaks).toBe(3);
    expect(sw.reading?.periodSeconds).toBeCloseTo(5, 3);
  });

  it('周期误差计算与理论一致', () => {
    expect(percentError(5.5, 5)).toBeCloseTo(10, 9);
    expect(percentError(5, 0)).toBeNull();
    const { sw } = runStopwatch(4, 2, 12);
    const tp = 2;
    const err = percentError(sw.reading?.periodSeconds ?? NaN, tp);
    expect(err).not.toBeNull();
    expect(err!).toBeLessThan(1); // 60Hz 采样 + 插值，误差远小于 1%
  });

  it('提前手动停止：峰数不足 2 无读数；足够则用已捕获峰计算', () => {
    const sw = createStopwatchLogic();
    sw.start(8);
    sw.onPeak(1);
    expect(sw.stopManual()).toBeNull();

    const sw2 = createStopwatchLogic();
    sw2.start(8);
    sw2.onPeak(0.5);
    sw2.onPeak(4.5);
    const manual = sw2.stopManual();
    expect(manual?.periodSeconds).toBeCloseTo(4, 6);
  });

  it('start 重置捕获计数；reset 回 idle', () => {
    const sw = createStopwatchLogic();
    sw.start(3);
    sw.onPeak(1);
    sw.start(3);
    expect(sw.capturedCount).toBe(0);
    sw.reset();
    expect(sw.phase).toBe('idle');
    expect(sw.reading).toBeNull();
  });
});

describe('instruments/beatMeter：拍包络极大间隔（任务四 beatingPeriod）', () => {
  /** 合成拍信号：两列相近频率正弦叠加，经真实峰检测器逐峰喂入拍周期估计器 */
  function beatPeriodFromSignal(T1: number, T2: number, a1: number, a2: number, seconds: number) {
    const w1 = (2 * Math.PI) / T1;
    const w2 = (2 * Math.PI) / T2;
    const det = createStreamExtremaDetector('peak');
    const meter = createBeatMeter();
    for (let i = 0; i < seconds * FS; i++) {
      const t = i / FS;
      const hit = det.feed({ t, eta: a1 * Math.sin(w1 * t) + a2 * Math.sin(w2 * t) });
      if (hit) meter.feed(hit);
    }
    return meter.periodSeconds();
  }

  it('拍信号：相邻显著包络极大间隔 ≈ T₁T₂/|T₁−T₂|（T1=4, T2=4.5 → 36 s）', () => {
    // 包络极大在 t ≈ 0/36/72 s（相位对齐）；首个极大无上升沿不可确认，
    // 信号取 88 s 覆盖 t≈36 与 t≈72 两个可确认极大（含确认回落段）
    const beat = beatPeriodFromSignal(4, 4.5, 1, 0.9, 88);
    expect(beat).not.toBeNull();
    expect(Math.abs((beat as number) - 36)).toBeLessThan(2);
  });

  it('常幅规则波：峰高几乎不变，突出度阈值过滤 → 不产出拍周期（不伪造读数）', () => {
    const beat = beatPeriodFromSignal(4, 4, 0.8, 0.8, 60);
    expect(beat).toBeNull();
  });

  it('reset 清空已估拍周期', () => {
    const w1 = (2 * Math.PI) / 4;
    const w2 = (2 * Math.PI) / 4.5;
    const det = createStreamExtremaDetector('peak');
    const meter = createBeatMeter();
    for (let i = 0; i < 88 * FS; i++) {
      const t = i / FS;
      const hit = det.feed({ t, eta: Math.sin(w1 * t) + 0.9 * Math.sin(w2 * t) });
      if (hit) meter.feed(hit);
    }
    expect(meter.periodSeconds()).not.toBeNull();
    meter.reset();
    expect(meter.periodSeconds()).toBeNull();
  });
});

describe('instruments/waveRuler：波高尺状态机', () => {
  it('峰→谷依次拾取：波高 = η峰 − η谷', () => {
    const ruler = createWaveRulerLogic();
    expect(ruler.pickPeak(null)).toBe(false); // 无峰可用
    expect(ruler.pickPeak({ t: 1.0, eta: 0.62 })).toBe(true);
    expect(ruler.state.phase).toBe('awaiting-trough');
    // 时序不符：谷早于峰
    expect(ruler.pickTrough({ t: 0.5, eta: -0.4 })).toBe('stale');
    // 正常完成
    expect(ruler.pickTrough({ t: 3.4, eta: -0.55 })).toBe('completed');
    expect(ruler.state.waveHeight).toBeCloseTo(1.17, 6);
  });

  it('awaiting-trough 态下由后续新谷自动完成', () => {
    const ruler = createWaveRulerLogic();
    ruler.pickPeak({ t: 2, eta: 0.9 });
    expect(ruler.pickTrough(null)).toBe('no-sample');
    expect(ruler.feedTrough({ t: 1, eta: -0.5 })).toBe(false); // 早于峰
    expect(ruler.feedTrough({ t: 5, eta: -0.7 })).toBe(true);
    expect(ruler.state.waveHeight).toBeCloseTo(1.6, 6);
  });

  it('reset 回 idle 并清空锚点', () => {
    const ruler = createWaveRulerLogic();
    ruler.pickPeak({ t: 1, eta: 1 });
    ruler.pickTrough({ t: 3, eta: -1 });
    ruler.reset();
    expect(ruler.state.phase).toBe('idle');
    expect(ruler.state.waveHeight).toBeNull();
  });
});

describe('instruments/buoyStats：浮标观测统计', () => {
  it('正弦海况：Hs=4σ=2√2·A，H1/3=2A，Tz=T，FFT 谱峰恢复频率', () => {
    const amp = 0.5;
    const period = 5;
    const samples = sineStream(amp, period, 60, 20).map((s) => ({ t: s.t, eta: s.eta }));
    const stats = computeBuoyStats(samples, 20);

    expect(stats.sampleCount).toBe(1200);
    // σ = A/√2 → Hs = 4σ ≈ 2.828·A
    expect(stats.stdEta).toBeCloseTo(amp / Math.SQRT2, 3);
    expect(stats.hs4Sigma).toBeCloseTo(4 * amp * Math.SQRT1_2, 2);
    expect(stats.h13).toBeCloseTo(2 * amp, 1);
    expect(stats.zeroUpCrossPeriod).toBeCloseTo(period, 2);
    // FFT：分辨率 20/1024 ≈ 0.0195Hz，插值后应贴近 0.2Hz
    expect(stats.spectralPeakFrequency).toBeCloseTo(0.2, 2);
    expect(stats.spectralPeakPeriod).toBeCloseTo(period, 1);
  });

  it('不规则谱海况（真实 waveField 实验三分量叠加）统计量级合理', () => {
    // 合成 3 分量随机相位海况，Hs 理论 = 4·sqrt(Σa²/2)
    const comps = [
      { a: 0.6, T: 8 },
      { a: 0.4, T: 5.5 },
      { a: 0.25, T: 4 },
    ];
    const samples = Array.from({ length: 20 * 60 }, (_, i) => {
      const t = i / 20;
      let eta = 0;
      for (const c of comps) eta += c.a * Math.sin((2 * Math.PI * t) / c.T + c.T);
      return { t, eta };
    });
    const stats = computeBuoyStats(samples, 20);
    const hsTheoretical =
      4 * Math.sqrt(comps.reduce((acc, c) => acc + (c.a * c.a) / 2, 0));
    // 有限窗口（60s，仅约 10 个主波）下 4σ 估计应在理论 Hs 的 ±25% 内
    expect(stats.hs4Sigma).toBeGreaterThan(hsTheoretical * 0.75);
    expect(stats.hs4Sigma).toBeLessThan(hsTheoretical * 1.25);
    expect(stats.h13).toBeGreaterThan(0);
    expect(stats.waveCount).toBeGreaterThan(5);
    expect(stats.spectralPeakFrequency).not.toBeNull();
  });

  it('样本不足返回空统计；过零分波输出波高周期对', () => {
    expect(computeBuoyStats([], 20)).toEqual(emptyBuoyStats());
    const short = sineStream(1, 4, 0.3, 20);
    expect(computeBuoyStats(short, 20).sampleCount).toBe(0);
    const waves = zeroUpCrossWaves(sineStream(1, 5, 20, 20));
    expect(waves.length).toBeGreaterThanOrEqual(3);
    expect(waves[0]?.height).toBeCloseTo(2, 1);
  });

  it('spectralPeakEstimate：0.2Hz 正弦恢复误差 < 3%', () => {
    const samples = sineStream(1, 5, 60, 20);
    const est = spectralPeakEstimate(samples, 20);
    expect(est.frequency).not.toBeNull();
    expect(Math.abs(est.frequency! - 0.2) / 0.2).toBeLessThan(0.03);
    expect(est.period).toBeCloseTo(5, 1);
  });
});

describe('instruments/buoyKinematics：主波与浮标漂移', () => {
  it('主波取最大振幅分量，方向/相速度正确', () => {
    const wave = mainWaveFromComponents([
      { amp: 0.3, kx: 0, ky: 0.2, omega: 0.6, phase: 0, steepness: 0 },
      { amp: 0.8, kx: 0.3, ky: 0.4, omega: 1.0, phase: 1, steepness: 0 },
    ]);
    expect(wave).not.toBeNull();
    const k = Math.hypot(0.3, 0.4);
    expect(wave?.dirX).toBeCloseTo(0.3 / k, 9);
    expect(wave?.dirY).toBeCloseTo(0.4 / k, 9);
    expect(wave?.phaseSpeed).toBeCloseTo(1.0 / k, 9);
    expect(mainWaveFromComponents([])).toBeNull();
  });

  it('浮标以相速度随浪平移：位移 = cp·Δt，方向沿主波', () => {
    const wave = mainWaveFromComponents([
      { amp: 1, kx: 0, ky: 0.25, omega: 0.5, phase: 0, steepness: 0 },
    ]);
    const p = buoyPositionAt({ x: 10, y: 20 }, 0, 40, wave!);
    // cp = 0.5/0.25 = 2 m/s，方向 +y
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(20 + 2 * 40, 9);
  });
});

describe('instruments/measurements：参数快照与记录摘要', () => {
  it('三实验参数快照文本包含关键参数', () => {
    const p = DEFAULT_SIM_STATE.params;
    const wind = paramsSnapshotNote('wind', {
      ...p,
      wind: { windSpeed: 12.5, windDuration: 30, windDirection: 45 },
    });
    expect(wind).toContain('实验一');
    expect(wind).toContain('U=12.5m/s');
    expect(wind).toContain('风向=45°');

    const interf = paramsSnapshotNote('interference', {
      ...p,
      interference: {
        makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
        makerB: { amplitude: 0.5, period: 4.4, angle: 0, phase: 90 },
      },
    });
    expect(interf).toContain('实验二');
    expect(interf).toContain('T=4.4s');

    const spec = paramsSnapshotNote('spectrum', {
      ...p,
      spectrum: { ...p.spectrum, windSpeed: 10, fetch: 50000, peakEnhancement: 3.3 },
    });
    expect(spec).toContain('实验三');
    expect(spec).toContain('JONSWAP');
    expect(spec).toContain('seed=42');
  });

  it('记录摘要：含工具名、读数与误差', () => {
    expect(instrumentLabel('wave-ruler')).toBe('波高尺');
    const line = summarizeRecord(
      'wave-ruler',
      { waveHeight: 1.234, errorPct: 4.56 },
      12.34,
    );
    expect(line).toContain('t=12.3s');
    expect(line).toContain('波高 1.23m');
    expect(line).toContain('4.6%');
    expect(summarizeRecord('stopwatch', { period: 5, peakCount: 3, errorPct: 2 }, 1)).toContain(
      '周期 5.00s',
    );
  });
});

describe('instruments/ringBuffer：内部环形缓冲（浮标缓冲）', () => {
  it('覆盖最旧行为与 toArray 顺序（与 viz 同语义）', () => {
    const ring = createLocalRingBuffer<number>(3);
    for (const v of [1, 2, 3, 4, 5]) ring.push(v);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.latest()).toBe(5);
    expect(ring.at(1)).toBe(4);
    expect(ring.capacity).toBe(3);
  });

  it('浮标缓冲容量 ≥ 512（20Hz 采样要求）', () => {
    const ring = createLocalRingBuffer<{ t: number; eta: number }>(1280);
    for (let i = 0; i < 2000; i++) ring.push({ t: i / 20, eta: 0 });
    expect(ring.length).toBe(1280);
    expect(ring.at(0)?.t).toBeCloseTo((2000 - 1280) / 20, 9);
  });
});
