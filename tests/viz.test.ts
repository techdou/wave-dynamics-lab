/**
 * viz 模块测试 —— 环形缓冲行为、时序极值扫描、分量谱能量、图表数学工具。
 * vitest 环境 node（无 DOM）：Canvas 绘制层不在此覆盖，仅覆盖纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import { createRingBuffer } from '../src/viz/ringBuffer';
import { scanExtrema } from '../src/viz/sampleScan';
import { componentEnergyStems } from '../src/viz/componentSpectrum';
import {
  formatPercent,
  formatSigned,
  niceCeil,
  niceTimeStep,
  percentError,
} from '../src/viz/chartMath';

describe('viz/ringBuffer：环形缓冲行为', () => {
  it('未满时按写入顺序读取；满后覆盖最旧样本（回绕）', () => {
    const ring = createRingBuffer<{ t: number; v: number }>(4);
    expect(ring.length).toBe(0);
    expect(ring.latest()).toBeUndefined();

    ring.push({ t: 0, v: 0 });
    ring.push({ t: 1, v: 1 });
    ring.push({ t: 2, v: 2 });
    expect(ring.length).toBe(3);
    expect(ring.at(0)?.t).toBe(0);
    expect(ring.latest()?.t).toBe(2);

    ring.push({ t: 3, v: 3 });
    ring.push({ t: 4, v: 4 }); // 覆盖 t=0
    ring.push({ t: 5, v: 5 }); // 覆盖 t=1
    expect(ring.length).toBe(4);
    expect(ring.toArray().map((s) => s.t)).toEqual([2, 3, 4, 5]);
    expect(ring.at(0)?.t).toBe(2);
    expect(ring.at(3)?.t).toBe(5);
    expect(ring.at(4)).toBeUndefined();
  });

  it('容量 ≥ 512 @20Hz 场景：写入 1024 点后保留最新 512 点且时间连续', () => {
    const ring = createRingBuffer<{ t: number; v: number }>(512);
    for (let i = 0; i < 1024; i++) {
      ring.push({ t: i / 20, v: Math.sin(i) });
    }
    expect(ring.length).toBe(512);
    const all = ring.toArray();
    // 时间序连续、无空洞
    for (let i = 1; i < all.length; i++) {
      expect((all[i] as { t: number }).t - (all[i - 1] as { t: number }).t).toBeCloseTo(0.05, 9);
    }
    expect(all[0]?.t).toBeCloseTo((1024 - 512) / 20, 9);
    expect(all[511]?.t).toBeCloseTo(1023 / 20, 9);
  });

  it('clear 清空；单元素缓冲正常工作', () => {
    const ring = createRingBuffer<number>(1);
    ring.push(1);
    ring.push(2);
    expect(ring.length).toBe(1);
    expect(ring.latest()).toBe(2);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.at(0)).toBeUndefined();
  });
});

describe('viz/sampleScan：时序极值扫描', () => {
  const fs = 20;
  const sine = (amp: number, period: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      t: i / fs,
      v: amp * Math.sin((2 * Math.PI * i) / period / fs),
    }));

  it('正弦序列的峰谷数量与位置正确', () => {
    const samples = sine(1, 5, 20 * 12); // 12 s，周期 5 s → 3 个完整峰（1.25/6.25/11.25s）
    const peaks = scanExtrema(samples, 'peak');
    const troughs = scanExtrema(samples, 'trough');
    expect(peaks.length).toBe(3);
    expect(peaks[0]?.t).toBeCloseTo(1.25, 1);
    expect(peaks[0]?.v).toBeCloseTo(1, 3);
    expect(peaks[2]?.t).toBeCloseTo(11.25, 1);
    // 谷位于 3.75s、8.75s（12s 窗口内 2 个）
    expect(troughs.length).toBe(2);
    expect(troughs[0]?.t).toBeCloseTo(3.75, 1);
    expect(troughs[0]?.v).toBeCloseTo(-1, 3);
  });

  it('时间缺口（暂停恢复/探针跳变）两侧不产生伪极值', () => {
    const samples = [
      ...sine(1, 5, 20 * 4).slice(0, -3), // 0–4s 截断在下降段
      ...sine(1, 5, 20 * 4).map((s) => ({ ...s, t: s.t + 10 })), // 10–14s 同相位续接
    ];
    const peaks = scanExtrema(samples, 'peak');
    // 缺口附近（t≈4 / t≈10）不得报峰；6.25s 的峰落在缺口内，
    // 仅剩真实峰 1.25s 与 11.25s（第二段为第一序列平移 10s）
    expect(peaks.map((p) => p.t)).toEqual([
      expect.closeTo(1.25, 1),
      expect.closeTo(11.25, 1),
    ]);
  });

  it('单调序列无极值；样本不足返回空', () => {
    expect(scanExtrema([{ t: 0, v: 0 }, { t: 1, v: 1 }], 'peak')).toHaveLength(0);
    const rising = [0, 1, 2, 3, 4].map((v, i) => ({ t: i, v }));
    expect(scanExtrema(rising, 'peak')).toHaveLength(0);
    expect(scanExtrema(rising, 'trough')).toHaveLength(0);
  });
});

describe('viz/componentSpectrum：分量离散谱能量', () => {
  it('两分量等频距：能量密度 = a²/(2Δf)，频率 = ω/2π', () => {
    const df = 0.05;
    const stems = componentEnergyStems([
      { amp: 0.5, kx: 0, ky: 1, omega: 2 * Math.PI * 0.1, phase: 0, steepness: 0 },
      { amp: 1.0, kx: 0, ky: 1, omega: 2 * Math.PI * 0.15, phase: 0, steepness: 0 },
    ]);
    expect(stems).toHaveLength(2);
    expect(stems[0]?.f).toBeCloseTo(0.1, 9);
    expect(stems[1]?.f).toBeCloseTo(0.15, 9);
    expect(stems[0]?.energyDensity).toBeCloseTo(0.25 / (2 * df), 6);
    expect(stems[1]?.energyDensity).toBeCloseTo(1.0 / (2 * df), 6);
  });

  it('过滤零振幅/零频率分量；单分量退化为名义带宽', () => {
    const stems = componentEnergyStems([
      { amp: 0, kx: 0, ky: 1, omega: 1, phase: 0, steepness: 0 },
      { amp: 0.8, kx: 0, ky: 1, omega: 0, phase: 0, steepness: 0 },
      { amp: 0.8, kx: 0, ky: 1, omega: 2 * Math.PI * 0.2, phase: 0, steepness: 0 },
    ]);
    expect(stems).toHaveLength(1);
    expect(stems[0]?.f).toBeCloseTo(0.2, 9);
    expect(stems[0]?.energyDensity).toBeCloseTo(
      0.64 / (2 * (1 / 32)),
      6,
    );
  });
});

describe('viz/chartMath：图表数值工具', () => {
  it('niceCeil 向上取整到好看刻度', () => {
    expect(niceCeil(0.13)).toBeCloseTo(0.15, 9);
    expect(niceCeil(1.01)).toBe(1.5);
    expect(niceCeil(2.6)).toBe(5);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-3)).toBe(1);
  });

  it('niceTimeStep 满足刻度数上限', () => {
    expect(niceTimeStep(60)).toBe(10); // 60/10 = 6 ≤ 8
    expect(niceTimeStep(300)).toBe(60);
    expect(niceTimeStep(5)).toBe(1);
  });

  it('percentError 与格式化', () => {
    expect(percentError(1.1, 1.0)).toBeCloseTo(10, 9);
    expect(percentError(0.5, 0)).toBeNull(); // 理论为 0 不可比
    expect(percentError(NaN, 1)).toBeNull();
    expect(formatPercent(null)).toBe('—');
    expect(formatSigned(0.25, 3)).toBe('+0.250');
    expect(formatSigned(-0.25, 2)).toBe('-0.25');
  });
});
