/**
 * 核心契约占位测试 —— 验证 core 三件（store/clock）与 physics 骨架实现的数学约定。
 * 各模块工程师实现后应在本目录补各自的测试文件（tests/<module>.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { createSimClock } from '../src/core/clock';
import {
  DEFAULT_SIM_STATE,
  DEFAULT_STEP_SECONDS,
  MAX_WAVE_COMPONENTS,
} from '../src/core/constants';
import { createStore } from '../src/core/store';
import { createWaveField } from '../src/physics/waveField';

describe('store：极简 pub/sub', () => {
  it('setState 浅合并并同步通知订阅者（带新旧状态）', () => {
    const store = createStore({ a: 1, b: 2 });
    const seen: Array<{ a: number; b: number; prevA: number }> = [];
    store.subscribe((s, prev) => seen.push({ a: s.a, b: s.b, prevA: prev.a }));

    store.setState({ a: 10 });
    expect(store.getState()).toEqual({ a: 10, b: 2 });
    expect(seen).toEqual([{ a: 10, b: 2, prevA: 1 }]);
  });

  it('函数式 patch 基于当前 state；空 patch 不通知', () => {
    const store = createStore({ n: 1 });
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    store.setState((s) => ({ n: s.n + 41 }));
    expect(store.getState().n).toBe(42);

    calls = 0;
    store.setState({});
    expect(calls).toBe(0);
  });

  it('事件总线 emit/on 与退订', () => {
    const store = createStore<{ v: number }>({ v: 0 });
    const received: unknown[] = [];
    const off = store.on('test:event', (p) => received.push(p));

    store.emit('test:event', 7);
    off();
    store.emit('test:event', 8);

    expect(received).toEqual([7]);
  });
});

describe('clock：固定步长仿真时钟', () => {
  it('按固定步长推进并触发 onStep；返回本帧推进的仿真秒数', () => {
    const clock = createSimClock();
    const steps: number[] = [];
    clock.onStep((t) => steps.push(t));

    const advanced = clock.advance(1 / 20); // 0.05s ≈ 3 步
    expect(steps.length).toBe(3);
    expect(Math.abs(advanced - 3 * DEFAULT_STEP_SECONDS)).toBeLessThan(1e-12);
    expect(clock.time()).toBeCloseTo(3 * DEFAULT_STEP_SECONDS, 12);
  });

  it('暂停时不推进；resume 后继续', () => {
    const clock = createSimClock();
    clock.pause();
    expect(clock.advance(0.1)).toBe(0);
    expect(clock.time()).toBe(0);
    clock.resume();
    expect(clock.advance(0.1)).toBeGreaterThan(0);
  });

  it('2 倍速推进翻倍；reset 归零且保留暂停态与倍速', () => {
    const clock = createSimClock();
    clock.setScale(2);
    const advanced = clock.advance(1); // 1 真实秒 × 2，但受单帧 8 步上限
    expect(advanced).toBeCloseTo(8 * DEFAULT_STEP_SECONDS, 12);

    clock.pause();
    clock.reset();
    expect(clock.time()).toBe(0);
    expect(clock.isPaused()).toBe(true);
    expect(clock.scale()).toBe(2);
  });
});

describe('waveField：骨架实现数学约定', () => {
  it('实验一：分量数 ≤ 64，η 有限，法线为单位向量', () => {
    const field = createWaveField();
    field.configure('wind', {
      ...DEFAULT_SIM_STATE.params,
      wind: { windSpeed: 10, windDuration: 30, windDirection: 0 },
    });

    expect(field.components().length).toBeLessThanOrEqual(MAX_WAVE_COMPONENTS);
    const sample = field.evalSurface(3, 4, 7);
    expect(Number.isFinite(sample.eta)).toBe(true);
    const { normal } = sample;
    expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 12);
  });

  it('实验二：同参数反相双波 ⇒ 波面处处为零（相消）', () => {
    const field = createWaveField();
    field.configure('interference', {
      ...DEFAULT_SIM_STATE.params,
      interference: {
        makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
        makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 180 },
      },
    });

    for (const t of [0, 1.37, 3.9]) {
      for (const x of [0, 2.5]) {
        expect(Math.abs(field.evalSurface(x, 8, t).eta)).toBeLessThan(1e-9);
      }
    }
  });

  it('实验三：谱密度为正、海况摘要落在合理范围、whitecap ∈ [0,1]', () => {
    const field = createWaveField();
    const params = {
      ...DEFAULT_SIM_STATE.params,
      spectrum: { ...DEFAULT_SIM_STATE.params.spectrum, windSpeed: 10 },
    };
    field.configure('spectrum', params);

    const sea = field.observedSeaState();
    expect(sea.hs).toBeGreaterThan(0);
    expect(sea.hs).toBeLessThan(20);
    expect(sea.tp).toBeGreaterThan(0);
    expect(sea.wavelength).toBeGreaterThan(0);
    expect(field.spectrum(sea.peakFrequency)).toBeGreaterThan(0);
    expect(field.whitecapIntensity()).toBeGreaterThanOrEqual(0);
    expect(field.whitecapIntensity()).toBeLessThanOrEqual(1);
  });

  it('深水水质点轨迹：表面位移幅值 ≈ 振幅，且随深度指数衰减', () => {
    const field = createWaveField();
    field.configure('interference', {
      ...DEFAULT_SIM_STATE.params,
      interference: {
        makerA: { amplitude: 1, period: 5, angle: 0, phase: 0 },
        makerB: { amplitude: 0, period: 5, angle: 0, phase: 0 },
      },
    });

    const comp = field.components()[0];
    expect(comp).toBeDefined();
    const a = comp ? comp.amp : 0;
    const t = 1.23;

    const atSurface = field.particleOrbit(0, 0, 0, t);
    const dx = atSurface.x - 0;
    const dy = atSurface.y - 0;
    const dz = atSurface.z - 0;
    // 深水圆轨迹：任意时刻水团位移模 = 轨迹半径 a（方向 0° ⇒ 圆在 y-z 平面）
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(a, 6);

    // particleOrbit 返回绝对坐标，位移需扣除基准位置；深水衰减 e^{kz}
    const deep = field.particleOrbit(0, 0, -6, t);
    const deepDisp = Math.hypot(deep.x, deep.y, deep.z - (-6));
    expect(deepDisp).toBeLessThan(a * 0.5);
  });

  it('实验一/二为非谱海况：spectrum 返回 0', () => {
    const field = createWaveField();
    field.configure('wind', DEFAULT_SIM_STATE.params);
    expect(field.spectrum(0.2)).toBe(0);
  });
});
