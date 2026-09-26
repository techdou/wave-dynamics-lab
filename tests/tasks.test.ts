/**
 * 任务系统测试 —— 六个判定器（正例 / 反例 / 边界）+ 探究闭环 + 防误触 + 持久化。
 * 判定输入用构造的合成测量事件（MeasurementRecord）驱动，与真实仪器写入路径一致
 * （store.setState 追加 + emit MEASUREMENT_ADDED）。
 */
import { describe, expect, it } from 'vitest';
import { createSimClock } from '../src/core/clock';
import { DEFAULT_SIM_STATE, STORE_EVENTS } from '../src/core/constants';
import { createStore } from '../src/core/store';
import type {
  InstrumentKind,
  InterferenceExperimentParams,
  SimState,
  SpectrumExperimentParams,
  WindExperimentParams,
} from '../src/core/types';
import { createWaveField } from '../src/physics/waveField';
import { circularDiffDeg, beatPeriodSeconds } from '../src/tasks/judges';
import { createMemoryStorage, type KeyValueStore } from '../src/tasks/persistence';
import { TASK_EVENTS } from '../src/tasks/taskEvents';
import { createTasks, type Tasks } from '../src/tasks/tasks';

// ============================================================
// 测试装置：store + waveField + clock + tasks（同集成工程师的组装方式）
// ============================================================

interface Rig {
  store: ReturnType<typeof createStore<SimState>>;
  waveField: ReturnType<typeof createWaveField>;
  clock: ReturnType<typeof createSimClock>;
  tasks: Tasks;
}

let recordSeq = 0;

function makeRig(storage?: KeyValueStore | null): Rig {
  const store = createStore<SimState>(structuredClone(DEFAULT_SIM_STATE));
  const waveField = createWaveField();
  const clock = createSimClock();
  const tasks = createTasks({ store, waveField, clock, storage });
  return { store, waveField, clock, tasks };
}

/** 模拟实验层参数流：setState（含 experiment 切换）→ configure → emit(PARAMS_CHANGED) → tasks.evaluate() */
function setWind(rig: Rig, patch: Partial<WindExperimentParams>): void {
  const params = {
    ...rig.store.getState().params,
    wind: { ...rig.store.getState().params.wind, ...patch },
  };
  rig.store.setState({ experiment: 'wind', params });
  rig.waveField.configure('wind', params);
  rig.store.emit(STORE_EVENTS.PARAMS_CHANGED, params);
  rig.tasks.evaluate();
}

function setInterference(
  rig: Rig,
  patch: Partial<InterferenceExperimentParams>,
): void {
  const current = rig.store.getState().params.interference;
  const merged: InterferenceExperimentParams = {
    makerA: { ...current.makerA, ...(patch.makerA ?? {}) },
    makerB: { ...current.makerB, ...(patch.makerB ?? {}) },
  };
  const params = { ...rig.store.getState().params, interference: merged };
  rig.store.setState({ experiment: 'interference', params });
  rig.waveField.configure('interference', params);
  rig.store.emit(STORE_EVENTS.PARAMS_CHANGED, params);
  rig.tasks.evaluate();
}

function setSpectrum(rig: Rig, patch: Partial<SpectrumExperimentParams>): void {
  const params = {
    ...rig.store.getState().params,
    spectrum: { ...rig.store.getState().params.spectrum, ...patch },
  };
  rig.store.setState({ experiment: 'spectrum', params });
  rig.waveField.configure('spectrum', params);
  rig.store.emit(STORE_EVENTS.PARAMS_CHANGED, params);
  rig.tasks.evaluate();
}

/** 合成一次仪器测量事件（与 instruments 契约一致的写入路径） */
function addRecord(
  rig: Rig,
  tool: InstrumentKind,
  values: Record<string, number>,
): void {
  const rec = {
    id: `test-record-${++recordSeq}`,
    tool,
    simTime: rig.clock.time(),
    values,
  };
  rig.store.setState({ measurements: [...rig.store.getState().measurements, rec] });
  rig.store.emit(STORE_EVENTS.MEASUREMENT_ADDED, rec);
}

function predict(rig: Rig, taskId: Parameters<Tasks['setPrediction']>[0], text: string): void {
  rig.tasks.setPrediction(taskId, text);
}

function checkOf(outcome: ReturnType<Tasks['submitResult']>, id: string) {
  const check = outcome.checks.find((c) => c.id === id);
  expect(check, `判定项 ${id} 应存在`).toBeDefined();
  return check as NonNullable<typeof check>;
}

// ============================================================
// 判定辅助函数（纯数学）
// ============================================================

describe('judges 辅助函数', () => {
  it('circularDiffDeg 正确处理跨零角度', () => {
    expect(circularDiffDeg(350, 10)).toBe(20);
    expect(circularDiffDeg(10, 350)).toBe(20);
    expect(circularDiffDeg(0, 90)).toBe(90);
    expect(circularDiffDeg(180, 0)).toBe(180);
    expect(circularDiffDeg(45, 45)).toBe(0);
  });

  it('beatPeriodSeconds：周期相等时无拍（无穷大）', () => {
    expect(beatPeriodSeconds(4, 4)).toBe(Number.POSITIVE_INFINITY);
    expect(beatPeriodSeconds(4, 5)).toBeCloseTo(20, 10);
  });
});

// ============================================================
// 任务一 · 白帽浪观测
// ============================================================

describe('任务一 whitecap：白帽海况', () => {
  it('正例：风速 18、强度 0.5 持续 5.2s、有波高尺记录 → 通过', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    predict(rig, 'whitecap', '风速15以上会出现白帽，波高变大');
    addRecord(rig, 'wave-ruler', { eta: 0.8, waveHeight: 1.6 });
    advanceAndEvaluate(rig, 5.2);

    const outcome = rig.tasks.submitResult('whitecap');
    expect(outcome.passed).toBe(true);
    expect(rig.tasks.getProgress('whitecap')).toEqual({ done: true, progress: 1 });
  });

  it('防误触：观测时长不足 5 秒 → 不通过（observation 项失败）', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    predict(rig, 'whitecap', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(rig, 3.0);

    const outcome = rig.tasks.submitResult('whitecap');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'observation').ok).toBe(false);
  });

  it('反例：风速 10（白帽区间外且强度不足）→ 失败', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 10, windDuration: 60 });
    predict(rig, 'whitecap', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 0.4 });
    advanceAndEvaluate(rig, 6);

    const outcome = rig.tasks.submitResult('whitecap');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'wind-range').ok).toBe(false);
    expect(checkOf(outcome, 'intensity').ok).toBe(false);
  });

  it('反例：风时为 0（平静无浪，白帽强度 0）→ 失败', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 18, windDuration: 0 }); // calm：强度 0 < 0.3
    predict(rig, 'whitecap', '预测');
    advanceAndEvaluate(rig, 6);

    const outcome = rig.tasks.submitResult('whitecap');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'intensity').ok).toBe(false);
  });

  it('陈旧测量防作弊：参数变更后旧记录过期 → 失败', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    predict(rig, 'whitecap', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(rig, 5.2);
    // 参数一变：波场指纹更换，旧测量过期、观测时长清零
    setWind(rig, { windSpeed: 19 });

    const outcome = rig.tasks.submitResult('whitecap');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'ruler-record').ok).toBe(false);
    expect(checkOf(outcome, 'observation').ok).toBe(false);
  });
});

// ============================================================
// 任务二 · 相长干涉
// ============================================================

describe('任务二 max-amplitude：中央浮标振幅最大', () => {
  it('正例：同频同向同相，测量峰谷差 1.0 m（单列 0.5 m 的 2 倍）→ 通过', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
    });
    predict(rig, 'max-amplitude', '相位差0°时最大，是单波的2倍');
    addRecord(rig, 'wave-ruler', { eta: 1.0, waveHeight: 1.0 });
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('max-amplitude');
    expect(outcome.passed).toBe(true);
  });

  it('反例：相位差 120°（叠加峰谷差只有 0.5 m）→ 不达标', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 120 },
    });
    predict(rig, 'max-amplitude', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 0.5 }); // 真实物理值：2·0.25·cos60°=0.25 振幅 → 峰谷差 0.5
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('max-amplitude');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'measurement').ok).toBe(false);
  });

  it('反例：不同频（T_B=4.5s）→ 同频项失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4.5, angle: 0, phase: 0 },
    });
    predict(rig, 'max-amplitude', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.0 });
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('max-amplitude');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'same-period').ok).toBe(false);
  });

  it('反例：不同向（夹角 30°）→ 同向项失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 30, phase: 0 },
    });
    predict(rig, 'max-amplitude', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.0 });
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('max-amplitude');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'same-direction').ok).toBe(false);
  });
});

// ============================================================
// 任务三 · 相消干涉
// ============================================================

describe('任务三 zero-amplitude：让浮标安静下来', () => {
  it('正例：等幅反相，残余峰谷差 0.02 m（单列 0.5 m 的 4%）→ 通过', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 180 },
    });
    predict(rig, 'zero-amplitude', '等幅、反相时海面静止');
    addRecord(rig, 'wave-ruler', { waveHeight: 0.02 });
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('zero-amplitude');
    expect(outcome.passed).toBe(true);
  });

  it('边界：振幅差 5.7%（>5% 容差）→ 失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.53, period: 4, angle: 0, phase: 180 },
    });
    predict(rig, 'zero-amplitude', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 0.05 });
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('zero-amplitude');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'amplitude-match').ok).toBe(false);
  });

  it('反例：相位差 170°（偏离 180° 超过 5°）→ 失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 170 },
    });
    predict(rig, 'zero-amplitude', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 0.17 });
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('zero-amplitude');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'opposite-phase').ok).toBe(false);
  });
});

// ============================================================
// 任务四 · 拍
// ============================================================

describe('任务四 beating：制造明显的拍', () => {
  /** T_A=4, T_B=4.5：失谐 0.118∈[0.1,0.3]，理论拍周期 36 s */
  function makeBeating(rig: Rig, ampB = 0.5): void {
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: ampB, period: 4.5, angle: 0, phase: 0 },
    });
  }

  it('正例：失谐带宽内、等幅、测得拍周期 34s（理论 36s，误差 5.6%）→ 通过', () => {
    const rig = makeRig();
    makeBeating(rig);
    predict(rig, 'beating', '周期越接近拍越慢，拍周期=T1T2/|T1-T2|');
    addRecord(rig, 'stopwatch', { period: 4, beatingPeriod: 34 });
    advanceAndEvaluate(rig, 5.2);

    const outcome = rig.tasks.submitResult('beating');
    expect(outcome.passed).toBe(true);
  });

  it('反例：拍周期测量偏差 39%（>±20%）→ 失败', () => {
    const rig = makeRig();
    makeBeating(rig);
    predict(rig, 'beating', '预测');
    addRecord(rig, 'stopwatch', { beatingPeriod: 50 });
    advanceAndEvaluate(rig, 5.2);

    const outcome = rig.tasks.submitResult('beating');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'beat-period').ok).toBe(false);
  });

  it('反例：周期完全相等（失谐为零，无拍）→ 失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
    });
    predict(rig, 'beating', '预测');
    addRecord(rig, 'stopwatch', { beatingPeriod: 999 });
    advanceAndEvaluate(rig, 5.2);

    const outcome = rig.tasks.submitResult('beating');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'detune-band').ok).toBe(false);
  });

  it('边界：失谐 0.095（低于 0.1 下限）→ 失败；0.106 → 带宽项通过', () => {
    const rigLow = makeRig();
    setInterference(rigLow, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4.4, angle: 0, phase: 0 },
    });
    predict(rigLow, 'beating', '预测');
    addRecord(rigLow, 'stopwatch', { beatingPeriod: 44 });
    advanceAndEvaluate(rigLow, 5.2);
    expect(rigLow.tasks.submitResult('beating').passed).toBe(false);

    const rigIn = makeRig();
    setInterference(rigIn, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4.45, angle: 0, phase: 0 },
    });
    predict(rigIn, 'beating', '预测');
    addRecord(rigIn, 'stopwatch', { beatingPeriod: 39.6 }); // 理论 4*4.45/0.45≈39.56
    advanceAndEvaluate(rigIn, 5.2);
    const outcome = rigIn.tasks.submitResult('beating');
    expect(checkOf(outcome, 'detune-band').ok).toBe(true);
  });

  it('反例：振幅悬殊（包络对比 1.67:1 < 2:1）→ 失败', () => {
    const rig = makeRig();
    makeBeating(rig, 2);
    predict(rig, 'beating', '预测');
    addRecord(rig, 'stopwatch', { beatingPeriod: 34 });
    advanceAndEvaluate(rig, 5.2);

    const outcome = rig.tasks.submitResult('beating');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'envelope-contrast').ok).toBe(false);
  });
});

// ============================================================
// 任务五 · 格状波（启发式）
// ============================================================

describe('任务五 grid-pattern：交叉格状波面', () => {
  it('正例：夹角 90°、两波等幅，观察 4.2s 后提交 → 通过，且标注启发式', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 90, phase: 0 },
    });
    predict(rig, 'grid-pattern', '夹角90°时格子最接近正方形');
    advanceAndEvaluate(rig, 4.2);

    const outcome = rig.tasks.submitResult('grid-pattern');
    expect(outcome.passed).toBe(true);
    const detail = rig.tasks.getTaskDetail('grid-pattern');
    expect(detail.heuristicNote).toContain('启发式');
  });

  it('反例：夹角 30°（不足 60°）→ 失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 30, phase: 0 },
    });
    predict(rig, 'grid-pattern', '预测');
    advanceAndEvaluate(rig, 4.2);
    const outcome = rig.tasks.submitResult('grid-pattern');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'angle-band').ok).toBe(false);
  });

  it('反例：夹角 170°（超过 120° 带宽）→ 失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 170, phase: 0 },
    });
    predict(rig, 'grid-pattern', '预测');
    advanceAndEvaluate(rig, 4.2);
    const outcome = rig.tasks.submitResult('grid-pattern');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'angle-band').ok).toBe(false);
  });

  it('反例：弱波振幅仅为强波 2.5%（启发式可见性不足）→ 失败', () => {
    const rig = makeRig();
    setInterference(rig, {
      makerA: { amplitude: 2, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.05, period: 4, angle: 90, phase: 0 },
    });
    predict(rig, 'grid-pattern', '预测');
    advanceAndEvaluate(rig, 4.2);
    const outcome = rig.tasks.submitResult('grid-pattern');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'both-visible').ok).toBe(false);
  });
});

// ============================================================
// 任务六 · 未知海况还原
// ============================================================

describe('任务六 unknown-sea：未知海况还原', () => {
  interface MysteryRig extends Rig {
    truth: { hs: number; tp: number };
  }

  function makeMystery(rig: Rig): MysteryRig {
    setSpectrum(rig, { mystery: true });
    const sea = rig.waveField.observedSeaState();
    return { ...rig, truth: { hs: sea.hs, tp: sea.tp } };
  }

  function addEvidence(rig: Rig): void {
    addRecord(rig, 'wave-ruler', { waveHeight: 1.0 });
    addRecord(rig, 'stopwatch', { period: 6 });
  }

  it('正例：估计误差 Hs 5% / Tp 2% → 通过，详情含真值/估值/误差', () => {
    const rig = makeMystery(makeRig());
    predict(rig, 'unknown-sea', '用波高尺统计波高、秒表测周期');
    addEvidence(rig);
    const outcome = rig.tasks.submitResult('unknown-sea', {
      hs: rig.truth.hs * 0.95,
      tp: rig.truth.tp * 1.02,
    });
    expect(outcome.passed).toBe(true);

    const detail = rig.tasks.getTaskDetail('unknown-sea');
    expect(detail.unknownSeaOutcome).not.toBeNull();
    expect(detail.unknownSeaOutcome?.truthHs).toBeCloseTo(rig.truth.hs, 9);
    expect(detail.unknownSeaOutcome?.estimateHs).toBeCloseTo(rig.truth.hs * 0.95, 9);
    expect(detail.unknownSeaOutcome?.hsErrorPct).toBeCloseTo(5, 6);
  });

  it('反例：Hs 偏差 20%（>15%）→ 失败，真值仍不展示', () => {
    const rig = makeMystery(makeRig());
    predict(rig, 'unknown-sea', '预测');
    addEvidence(rig);
    const outcome = rig.tasks.submitResult('unknown-sea', {
      hs: rig.truth.hs * 1.2,
      tp: rig.truth.tp,
    });
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'hs-error').ok).toBe(false);
    expect(rig.tasks.getTaskDetail('unknown-sea').unknownSeaOutcome).toBeNull();
  });

  it('边界：Hs 误差恰 15%、Tp 误差恰 20% → 通过（容差含边界）', () => {
    const rig = makeMystery(makeRig());
    predict(rig, 'unknown-sea', '预测');
    addEvidence(rig);
    const outcome = rig.tasks.submitResult('unknown-sea', {
      hs: rig.truth.hs * 1.15,
      tp: rig.truth.tp * 1.2,
    });
    expect(outcome.passed).toBe(true);
  });

  it('反例：未开启 mystery 模式 → 失败', () => {
    const rig = makeRig();
    setSpectrum(rig, { mystery: false });
    predict(rig, 'unknown-sea', '预测');
    addEvidence(rig);
    const sea = rig.waveField.observedSeaState();
    const outcome = rig.tasks.submitResult('unknown-sea', { hs: sea.hs, tp: sea.tp });
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'mystery').ok).toBe(false);
  });

  it('反例：没有本海况下的仪器测量记录 → 失败（不许凭空猜）', () => {
    const rig = makeMystery(makeRig());
    predict(rig, 'unknown-sea', '预测');
    const outcome = rig.tasks.submitResult('unknown-sea', {
      hs: rig.truth.hs,
      tp: rig.truth.tp,
    });
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'evidence-ruler').ok).toBe(false);
    expect(checkOf(outcome, 'evidence-stopwatch').ok).toBe(false);
  });

  it('反例：提交 NaN 估计值 → 失败且不产生真值记录', () => {
    const rig = makeMystery(makeRig());
    predict(rig, 'unknown-sea', '预测');
    addEvidence(rig);
    const outcome = rig.tasks.submitResult('unknown-sea', { hs: Number.NaN, tp: Number.NaN });
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'hs-error').ok).toBe(false);
    expect(rig.tasks.getTaskDetail('unknown-sea').unknownSeaOutcome).toBeNull();
  });
});

// ============================================================
// 探究闭环 / 防误触 / 事件 / 进度
// ============================================================

/** 按帧推进仿真时钟并刷新任务评估（模拟集成层：每帧 advance 一次，时钟按固定步长走） */
function advanceAndEvaluate(rig: Rig, seconds: number): void {
  const frames = Math.ceil(seconds / (1 / 60));
  for (let i = 0; i < frames; i++) rig.clock.advance(1 / 60);
  rig.tasks.evaluate();
}

describe('探究闭环与事件', () => {
  it('未填预测不允许提交结果', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    addRecord(rig, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(rig, 5.2);

    const outcome = rig.tasks.submitResult('whitecap');
    expect(outcome.passed).toBe(false);
    expect(checkOf(outcome, 'prediction').ok).toBe(false);
  });

  it('通过时 emit COMPLETED（AI 总结/TTS 钩子，含口播文本）；重复提交不重复发', () => {
    const rig = makeRig();
    let judgedCount = 0;
    let completedCount = 0;
    let speech = '';
    rig.store.on(TASK_EVENTS.JUDGED, () => {
      judgedCount += 1;
    });
    rig.store.on(TASK_EVENTS.COMPLETED, (payload) => {
      completedCount += 1;
      const view = payload as { speech?: string };
      speech = view.speech ?? '';
    });

    setWind(rig, { windSpeed: 18, windDuration: 60 });
    predict(rig, 'whitecap', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(rig, 5.2);
    expect(rig.tasks.submitResult('whitecap').passed).toBe(true);
    expect(judgedCount).toBe(1);
    expect(completedCount).toBe(1);
    expect(speech).toContain('任务一');

    const again = rig.tasks.submitResult('whitecap');
    expect(again.alreadyCompleted).toBe(true);
    expect(judgedCount).toBe(1);
    expect(completedCount).toBe(1);
  });

  it('进度持续可见：观测中进度上升、顶栏可读；状态稳定时 evaluate 不再刷 TASKS_UPDATED', () => {
    const rig = makeRig();
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    expect(rig.tasks.getProgress('whitecap').progress).toBe(0);

    advanceAndEvaluate(rig, 2.5);
    const mid = rig.tasks.getProgress('whitecap').progress;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    let updates = 0;
    rig.store.on(STORE_EVENTS.TASKS_UPDATED, () => {
      updates += 1;
    });
    for (let i = 0; i < 10; i++) rig.tasks.evaluate();
    expect(updates).toBe(0); // 状态未变不得刷事件（防 60Hz 事件风暴）
  });

  it('reset 清空预测、完成态与持久化', () => {
    const storage = createMemoryStorage();
    const rig = makeRig(storage);
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    predict(rig, 'whitecap', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(rig, 5.2);
    expect(rig.tasks.submitResult('whitecap').passed).toBe(true);

    rig.tasks.reset();
    expect(rig.tasks.getProgress('whitecap')).toEqual({ done: false, progress: 0 });
    expect(rig.tasks.getTaskDetail('whitecap').prediction).toBe('');
    expect(storage.getItem('wave-lab:tasks:v1')).toBeNull();
  });
});

// ============================================================
// 持久化（localStorage try/catch 降级）
// ============================================================

describe('进度持久化', () => {
  it('完成后进度落盘，新会话（同 storage）恢复 done 与预测', () => {
    const storage = createMemoryStorage();
    const first = makeRig(storage);
    setWind(first, { windSpeed: 18, windDuration: 60 });
    predict(first, 'whitecap', '风速15以上会出现白帽');
    addRecord(first, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(first, 5.2);
    expect(first.tasks.submitResult('whitecap').passed).toBe(true);

    const second = makeRig(storage);
    expect(second.tasks.getProgress('whitecap')).toEqual({ done: true, progress: 1 });
    expect(second.tasks.getTaskDetail('whitecap').prediction).toBe('风速15以上会出现白帽');
    const again = second.tasks.submitResult('whitecap');
    expect(again.alreadyCompleted).toBe(true);
  });

  it('隐私模式（存储抛错）不崩溃：判定与提交照常工作', () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('privacy mode');
      },
      setItem: () => {
        throw new Error('privacy mode');
      },
      removeItem: () => {
        throw new Error('privacy mode');
      },
    };
    const rig = makeRig(throwing);
    setWind(rig, { windSpeed: 18, windDuration: 60 });
    predict(rig, 'whitecap', '预测');
    addRecord(rig, 'wave-ruler', { waveHeight: 1.6 });
    advanceAndEvaluate(rig, 5.2);
    expect(rig.tasks.submitResult('whitecap').passed).toBe(true);
  });
});
