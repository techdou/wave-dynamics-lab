/**
 * 实验报告测试 —— generate() 内容完整性、Markdown/JSON 结构、任务六真值三列、
 * 时间线事件溯源、下载/复制的能力守卫（node 环境验证守卫分支）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSimClock } from '../src/core/clock';
import { DEFAULT_SIM_STATE, STORE_EVENTS } from '../src/core/constants';
import { createStore } from '../src/core/store';
import type { SimState, WindExperimentParams } from '../src/core/types';
import { createReport } from '../src/data/report';
import { createWaveField } from '../src/physics/waveField';
import { createTasks, type Tasks } from '../src/tasks/tasks';

interface Rig {
  store: ReturnType<typeof createStore<SimState>>;
  waveField: ReturnType<typeof createWaveField>;
  clock: ReturnType<typeof createSimClock>;
  tasks: Tasks;
  report: ReturnType<typeof createReport>;
}

function makeRig(): Rig {
  const store = createStore<SimState>(structuredClone(DEFAULT_SIM_STATE));
  const waveField = createWaveField();
  const clock = createSimClock();
  const tasks = createTasks({ store, waveField, clock });
  const report = createReport({ store, waveField, clock });
  return { store, waveField, clock, tasks, report };
}

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

let recordSeq = 0;

function addRecord(
  rig: Rig,
  tool: 'wave-ruler' | 'stopwatch',
  values: Record<string, number>,
): void {
  const rec = { id: `report-record-${++recordSeq}`, tool, simTime: rig.clock.time(), values };
  rig.store.setState({ measurements: [...rig.store.getState().measurements, rec] });
  rig.store.emit(STORE_EVENTS.MEASUREMENT_ADDED, rec);
}

/** 造一段完整会话：调参 → 测量 → 预测 → 观测 → 通过任务一 → AI 问答 */
function playWhitecapSession(rig: Rig): void {
  setWind(rig, { windSpeed: 18, windDuration: 60 });
  addRecord(rig, 'wave-ruler', { eta: 0.8, waveHeight: 1.6 });
  rig.tasks.setPrediction('whitecap', '风速15以上会出现白帽，波高变大');
  const frames = Math.ceil(5.2 / (1 / 60));
  for (let i = 0; i < frames; i++) rig.clock.advance(1 / 60);
  rig.tasks.evaluate();
  const outcome = rig.tasks.submitResult('whitecap');
  if (!outcome.passed) throw new Error(`测试会话未通过任务一：${outcome.feedback}`);
}

describe('报告 generate()：内容完整性', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    playWhitecapSession(rig);
  });

  it('包含参数快照、理论海况、测量、任务、预测、时间线', () => {
    const doc = rig.report.generate();
    expect(doc.experiment).toBe('wind');
    expect(doc.params.wind.windSpeed).toBe(18);
    expect(doc.seaState.hs).toBeGreaterThan(0);
    expect(doc.measurements.length).toBe(1);
    expect(doc.tasks.find((t) => t.taskId === 'whitecap')?.done).toBe(true);
    expect(doc.predictions?.some((p) => p.prediction.includes('白帽'))).toBe(true);
    const kinds = new Set((doc.timeline ?? []).map((e) => e.kind));
    for (const kind of ['params', 'measurement', 'prediction', 'judged', 'completed'] as const) {
      expect(kinds.has(kind), `时间线应含 ${kind}`).toBe(true);
    }
    expect(doc.unknownSea).toBeNull();
    expect(doc.modelNotes?.length).toBeGreaterThanOrEqual(8);
  });

  it('时间线条目带仿真时间戳（注入 clock 时）', () => {
    const doc = rig.report.generate();
    for (const entry of doc.timeline ?? []) {
      expect(entry.simTime).not.toBeNull();
      expect(entry.simTime as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('任务六：通过后报告含真值/估值/误差三列；未通过不含真值', () => {
    const rig6 = makeRig();
    rig6.store.setState({
      experiment: 'spectrum',
      params: {
        ...rig6.store.getState().params,
        spectrum: { ...rig6.store.getState().params.spectrum, mystery: true },
      },
    });
    rig6.waveField.configure('spectrum', rig6.store.getState().params);
    rig6.store.emit(STORE_EVENTS.PARAMS_CHANGED, null);
    rig6.tasks.evaluate();

    // 未通过 → 报告不含真值
    rig6.tasks.setPrediction('unknown-sea', '预测');
    addRecord(rig6, 'wave-ruler', { waveHeight: 1.0 });
    addRecord(rig6, 'stopwatch', { period: 6 });
    const truth = rig6.waveField.observedSeaState();
    rig6.tasks.submitResult('unknown-sea', { hs: truth.hs * 1.5, tp: truth.tp });
    expect(rig6.report.generate().unknownSea).toBeNull();

    // 通过 → 三列齐全
    const outcome = rig6.tasks.submitResult('unknown-sea', {
      hs: truth.hs * 0.95,
      tp: truth.tp * 1.02,
    });
    expect(outcome.passed).toBe(true);
    const us = rig6.report.generate().unknownSea;
    expect(us).not.toBeNull();
    expect(us?.truthHs).toBeCloseTo(truth.hs, 9);
    expect(us?.estimateHs).toBeCloseTo(truth.hs * 0.95, 9);
    expect(us?.passed).toBe(true);

    const markdown = rig6.report.exportMarkdown();
    expect(markdown).toContain('真值');
    expect(markdown).toContain('谱峰周期 Tp');
  });
});

describe('报告 exportMarkdown/exportJson：结构', () => {
  it('Markdown 覆盖八个章节与关键数据', () => {
    const rig = makeRig();
    playWhitecapSession(rig);
    const markdown = rig.report.exportMarkdown();

    expect(markdown).toContain('# 海浪动力学虚拟探索实验报告');
    expect(markdown).toContain('## 一、参数快照');
    expect(markdown).toContain('"windSpeed": 18');
    expect(markdown).toContain('## 二、理论海况');
    expect(markdown).toContain('## 三、任务完成情况');
    expect(markdown).toContain('任务一 · 白帽浪观测');
    expect(markdown).toContain('## 四、预测记录');
    expect(markdown).toContain('风速15以上会出现白帽');
    expect(markdown).toContain('## 五、操作时间线');
    expect(markdown).toContain('参数调整');
    expect(markdown).toContain('## 六、测量数据');
    expect(markdown).toContain('wave-ruler');
    expect(markdown).toContain('## 七、未知海况还原');
    expect(markdown).toContain('## 八、教学简化模型声明');
    expect(markdown).toContain('JONSWAP 教学版');
  });

  it('exportJson 可解析且字段齐全', () => {
    const rig = makeRig();
    playWhitecapSession(rig);
    const parsed = JSON.parse(rig.report.exportJson()) as {
      kind: string;
      version: number;
      experiment: string;
      measurements: unknown[];
      timeline: unknown[];
    };
    expect(parsed.kind).toBe('wave-lab-report');
    expect(parsed.version).toBe(1);
    expect(parsed.experiment).toBe('wind');
    expect(parsed.measurements).toHaveLength(1);
    expect(parsed.timeline.length).toBeGreaterThan(0);
  });

  it('无 clock 注入时报告仍可生成（时间线无仿真时间）', () => {
    const store = createStore<SimState>(structuredClone(DEFAULT_SIM_STATE));
    const waveField = createWaveField();
    const tasks = createTasks({ store, waveField });
    const report = createReport({ store, waveField });
    const doc = report.generate();
    expect(doc.generatedAtSimTime).toBe(0);
    expect(doc.timeline).toEqual([]);
    expect(report.exportMarkdown()).toContain('# 海浪动力学虚拟探索实验报告');
    void tasks;
  });
});

describe('报告导出工具：环境能力守卫', () => {
  it('node 环境（无 Blob/DOM/剪贴板）下 download/copy 返回 { ok:false } 而非抛错', async () => {
    const rig = makeRig();
    const download = await rig.report.download();
    expect(download.ok).toBe(false);
    expect(download.reason).toBeTruthy();

    const copied = await rig.report.copyToClipboard();
    expect(copied.ok).toBe(false);
    expect(copied.reason).toBeTruthy();
  });
});
