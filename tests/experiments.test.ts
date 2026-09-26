/**
 * 实验层测试 —— tests/experiments.test.ts（SPEC §3：每个模块补自己的
 * tests/<module>.test.ts）。
 * 覆盖三类断言（交付要求）：
 *   1. 参数 schema 完整性（键/范围/步长/默认值与 core 默认状态同源）；
 *   2. setParam → store + physics 联动（分量真实变化，一帧内生效，
 *      不止改 UI 状态——physics 直接用真实 WaveField 断言）；
 *   3. 风浪发展状态分类阈值边界（纯函数逐点边界表）。
 */
import { describe, expect, it } from 'vitest';
import { createSimClock } from '../src/core/clock';
import { DEFAULT_SIM_STATE, STORE_EVENTS } from '../src/core/constants';
import { createStore } from '../src/core/store';
import type { ExperimentId, SimParams, SimState } from '../src/core/types';
import { windGrowth } from '../src/physics/growth';
import { pmPeakFrequency, jonswapPeakFrequency } from '../src/physics/spectra';
import { createWaveField, WIND_TEACHING_FETCH } from '../src/physics/waveField';
import {
  createExperiments,
  EXPERIMENT_PARAM_SCHEMAS,
  classifyWindDevelopment,
  WIND_DEVELOPMENT_LABELS,
} from '../src/experiments/experiments';
import type { SliderParamItem } from '../src/experiments/types';

// ---------- 测试装配 ----------

function makeDeps() {
  return {
    store: createStore<SimState>(structuredClone(DEFAULT_SIM_STATE)),
    waveField: createWaveField(),
    // 单帧步数上限放宽：测试直接 advance 较长仿真时间，不受渲染帧 8 步上限约束
    clock: createSimClock({ maxStepsPerFrame: 1000 }),
  };
}

/** schema 键 → DEFAULT_SIM_STATE 默认值（验证 schema 与 store 初始状态同源） */
function defaultFor(experiment: ExperimentId, key: string): number | boolean | string {
  const dot = key.indexOf('.');
  if (experiment === 'interference') {
    const maker = key.slice(0, dot) as 'makerA' | 'makerB';
    const field = key.slice(dot + 1) as 'amplitude' | 'period' | 'angle' | 'phase';
    return DEFAULT_SIM_STATE.params.interference[maker][field];
  }
  if (experiment === 'wind') {
    return DEFAULT_SIM_STATE.params.wind[key as keyof SimParams['wind']];
  }
  return DEFAULT_SIM_STATE.params.spectrum[
    key as keyof SimParams['spectrum']
  ] as number | boolean | string;
}

function windParams(
  windSpeed: number,
  windDuration: number,
  windDirection = 0,
): SimParams['wind'] {
  return { windSpeed, windDuration, windDirection };
}

// ========== 1. 参数 schema 完整性 ==========

describe('参数 schema 完整性', () => {
  it('三实验 schema 均非空，键唯一，滑块范围/步长/默认值健全，标签非空', () => {
    const ids: ExperimentId[] = ['wind', 'interference', 'spectrum'];
    for (const id of ids) {
      const schema = EXPERIMENT_PARAM_SCHEMAS[id];
      expect(schema.length).toBeGreaterThan(0);

      const keys = schema.map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);

      for (const item of schema) {
        expect(item.label.length).toBeGreaterThan(0);
        if (item.control === 'slider' || item.control === undefined) {
          expect(item.min).toBeLessThan(item.max);
          expect(item.step).toBeGreaterThan(0);
          expect(item.step).toBeLessThanOrEqual(item.max - item.min);
          expect(item.default).toBeGreaterThanOrEqual(item.min);
          expect(item.default).toBeLessThanOrEqual(item.max);
          expect(Number.isFinite(item.min)).toBe(true);
          expect(Number.isFinite(item.max)).toBe(true);
        }
      }
    }
  });

  it('schema 默认值与 DEFAULT_SIM_STATE 同源（逐键一致）', () => {
    const ids: ExperimentId[] = ['wind', 'interference', 'spectrum'];
    for (const id of ids) {
      for (const item of EXPERIMENT_PARAM_SCHEMAS[id]) {
        expect(defaultFor(id, item.key)).toBe(item.default);
      }
    }
  });

  it('实验一：风速/风时为基础参数，风向仅高级模式开放', () => {
    const byKey = new Map(EXPERIMENT_PARAM_SCHEMAS.wind.map((i) => [i.key, i]));
    expect(byKey.get('windDirection')?.advanced).toBe(true);
    expect(byKey.get('windSpeed')?.advanced).toBeFalsy();
    expect(byKey.get('windDuration')?.advanced).toBeFalsy();
    // 范围与交付要求一致
    const speed = byKey.get('windSpeed') as SliderParamItem;
    expect(speed.min).toBe(0);
    expect(speed.max).toBe(30);
    const duration = byKey.get('windDuration') as SliderParamItem;
    expect(duration.min).toBe(0);
    expect(duration.max).toBe(60);
  });

  it('实验二：两台造波机各 4 参数（H/T/θ/φ）齐全且相互独立', () => {
    const keys = EXPERIMENT_PARAM_SCHEMAS.interference.map((i) => i.key);
    for (const maker of ['makerA', 'makerB'] as const) {
      for (const field of ['amplitude', 'period', 'angle', 'phase']) {
        expect(keys).toContain(`${maker}.${field}`);
      }
    }
    const amp = EXPERIMENT_PARAM_SCHEMAS.interference.find(
      (i) => i.key === 'makerA.amplitude',
    ) as SliderParamItem;
    expect(amp.min).toBe(0.05); // PARAM_LIMITS.interference.amplitude
    expect(amp.max).toBe(2);
    const period = EXPERIMENT_PARAM_SCHEMAS.interference.find(
      (i) => i.key === 'makerB.period',
    ) as SliderParamItem;
    expect(period.min).toBe(0.5); // SPEC §9.2：T 0.5–20 s
    expect(period.max).toBe(20);
  });

  it('实验三：基础 U/F + 高级模式 γ/种子/谱型/未知海况开关', () => {
    const schema = EXPERIMENT_PARAM_SCHEMAS.spectrum;
    const keys = schema.map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'windSpeed',
        'fetch',
        'kind',
        'peakEnhancement',
        'randomSeed',
        'mystery',
      ]),
    );
    const advanced = schema
      .filter((i) => i.advanced === true)
      .map((i) => i.key)
      .sort();
    expect(advanced).toEqual(['kind', 'mystery', 'peakEnhancement', 'randomSeed']);
  });
});

// ========== 2. setParam → store + physics 联动 ==========

describe('setParam → store + physics 联动（一帧内生效）', () => {
  it('实验一：setParam 后未推进时钟，store 与波场分量同步更新（一帧内生效）', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store, waveField, clock } = deps;

    rt.controllers.wind.setParam('windDuration', 30);
    rt.controllers.wind.setParam('windSpeed', 12);

    expect(clock.time()).toBe(0); // 未推进 ⇒ 生效不依赖帧循环
    expect(store.getState().params.wind.windSpeed).toBe(12);
    expect(waveField.components().length).toBeGreaterThan(0);

    // v0.2 成长模型（physics/growth.ts，SPM/JONSWAP 风时/风区幂律 + 充分发展封顶）：
    // 理论海况由 windGrowth(U, 风时min, 教学风区) 解析给出
    //（替换骨架公式 Hs≈0.21U²/g、Tp≈0.729U，见 src/physics/MODELS.md §2）
    const expected = windGrowth(12, 30, WIND_TEACHING_FETCH);
    const sea = waveField.observedSeaState();
    expect(sea.hs).toBeCloseTo(expected.hs, 9);
    expect(sea.tp).toBeCloseTo(expected.tp, 9);

    // 白帽：『局部陡度 + 风速门控』教学指标（MODELS.md §2 标定），
    // U=12 已过陡度起始段 ⇒ 指标非零且有界（替换骨架线性映射 (U−6)/24）
    const wc = waveField.whitecapIntensity();
    expect(wc).toBeGreaterThan(0);
    expect(wc).toBeLessThanOrEqual(1);

    const obs = rt.controllers.wind.observables();
    expect(obs.hs).toBe(sea.hs);
    expect(obs.whitecapIntensity).toBe(wc);
  });

  it('实验一：风速/风向连续调节时随机相位不重排（SPEC §9.1 禁止跳变）', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { waveField } = deps;

    rt.setParams({ wind: windParams(10, 30, 0) });
    const phases1 = waveField.components().map((c) => c.phase);

    rt.setParams({ wind: windParams(15, 30, 0) });
    expect(waveField.components().map((c) => c.phase)).toEqual(phases1);

    rt.setParams({ wind: windParams(15, 30, 200) });
    expect(waveField.components().map((c) => c.phase)).toEqual(phases1);
  });

  it('越界参数按 PARAM_LIMITS clamp 后落库，不抛错', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store } = deps;

    rt.controllers.wind.setParam('windSpeed', 99);
    expect(store.getState().params.wind.windSpeed).toBe(30);
    rt.controllers.wind.setParam('windSpeed', -5);
    expect(store.getState().params.wind.windSpeed).toBe(0);
    rt.controllers.wind.setParam('windDuration', 999);
    expect(store.getState().params.wind.windDuration).toBe(60);

    rt.controllers.interference.setParam('makerA.amplitude', 100);
    expect(store.getState().params.interference.makerA.amplitude).toBe(2);

    rt.controllers.spectrum.setParam('peakEnhancement', 99);
    expect(store.getState().params.spectrum.peakEnhancement).toBe(7);
    rt.controllers.spectrum.setParam('randomSeed', -1);
    expect(store.getState().params.spectrum.randomSeed).toBe(0);

    // clamp 后无实效变化 ⇒ 不发事件、不 commit（静默）
    let events = 0;
    store.on(STORE_EVENTS.PARAMS_CHANGED, () => (events += 1));
    rt.controllers.wind.setParam('windSpeed', -999);
    expect(events).toBe(0);
    expect(store.getState().params.wind.windSpeed).toBe(0);
  });

  it('未知参数键静默忽略，不抛错、不改动状态', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const before = JSON.stringify(deps.store.getState().params);
    expect(() => rt.controllers.wind.setParam('notAKey', 5)).not.toThrow();
    expect(() =>
      rt.controllers.interference.setParam('makerC.amplitude', 5),
    ).not.toThrow();
    expect(JSON.stringify(deps.store.getState().params)).toBe(before);
  });

  it('实验二：等幅反相双波 ⇒ 波面处处为零（相消，物理真实变化）', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { waveField } = deps;

    rt.controllers.interference.setParam('makerB.phase', 180);

    // 分量切换含 7s 平滑过渡（仿真时间驱动，混合期分量数取新旧较大值）；
    // 快进仿真时间令过渡收敛到目标分量，再断言稳态。
    waveField.evalSurface(0, 0, 0); // 建立仿真时间锚点
    waveField.evalSurface(0, 0, 20); // 快进 20s（> 7s 过渡窗口）
    const comps = waveField.components();
    expect(comps.length).toBe(2);
    expect(comps[1]?.phase).toBeCloseTo(Math.PI, 9);
    for (const t of [0, 1.37, 3.9]) {
      for (const x of [0, 2.5, -7]) {
        expect(Math.abs(waveField.evalSurface(x, 8, t).eta)).toBeLessThan(1e-9);
      }
    }

    const obs = rt.controllers.interference.observables();
    expect(obs.phaseDiffDeg).toBeCloseTo(180, 9);
    expect(obs.minAmp).toBeCloseTo(0, 9); // |a_A − a_B| = 0
  });

  it('实验二：只动指定造波机，另一台分量不变', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { waveField } = deps;

    // 集成仲裁（v0.2 平滑过渡语义，见 src/physics/MODELS.md §2）：
    // 先切到实验二再调参。setParam 属连续参数（SPEC §9.1 公式连续 ⇒ 分量直接取
    // 目标态）；若不切实验直接调，则等效『实验切换』真突变，显示分量按 τ≈1s
    // 指数过渡，components() 不再零滞后。
    rt.selectExperiment('interference');
    rt.controllers.interference.setParam('makerA.amplitude', 1);
    rt.controllers.interference.setParam('makerB.period', 8);

    const comps = waveField.components();
    expect(comps[0]?.amp).toBe(0.5); // H₁=1 ⇒ 振幅 0.5
    expect(comps[0]?.omega).toBeCloseTo((2 * Math.PI) / 4, 9); // T₁ 仍为默认 4
    expect(comps[1]?.omega).toBeCloseTo((2 * Math.PI) / 8, 9); // T₂=8
    expect(comps[1]?.amp).toBe(0.25); // H₂ 仍为默认 0.5
  });

  it('实验三：setParam 后谱海况真实重建，Tp 随 U 单调变化', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { waveField } = deps;

    // 注意：默认 U=10，设 10 无实效变化 ⇒ 不 commit；须改到不同值触发物理重建
    rt.controllers.spectrum.setParam('windSpeed', 12);
    const tp12 = waveField.observedSeaState().tp;
    expect(waveField.spectrum(waveField.observedSeaState().peakFrequency)).toBeGreaterThan(0);

    rt.controllers.spectrum.setParam('windSpeed', 20);
    const tp20 = waveField.observedSeaState().tp;
    expect(tp20).toBeGreaterThan(tp12); // U↑ ⇒ 谱峰频率↓ ⇒ Tp↑
    expect(waveField.components().length).toBeGreaterThan(0);
  });

  it('randomSeaState(seed)：同种子 ⇒ 同一海况（分量级一致），异种子相位不同', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { waveField } = deps;

    // 集成仲裁（v0.2 平滑过渡语义）：谱种子切换属『真突变』，显示分量按 τ≈1s
    // 指数过渡、≥7s 吸附到目标（MODELS.md §2）。用仿真时间驱动过渡完成
    //（evalSurface 的 t 观测）后再读 components()，断言即落在确定性目标态。
    const settleTransition = (): void => {
      for (let t = 0; t <= 8; t += 1) waveField.evalSurface(0, 0, t);
    };

    rt.controllers.spectrum.randomSeaState(7);
    settleTransition();
    const a = JSON.stringify(waveField.components()); // 目标态（已吸附）
    rt.controllers.spectrum.randomSeaState(7);
    const b = JSON.stringify(waveField.components()); // 同种子无实效变化 ⇒ 不重建
    expect(b).toBe(a); // 可复现

    rt.controllers.spectrum.randomSeaState(8); // 异种子 ⇒ 真突变 + 过渡
    settleTransition();
    const c = waveField.components(); // 目标态（种子 8）
    expect(JSON.stringify(c)).not.toBe(a);
    expect(c.map((x) => x.phase)).not.toEqual(
      JSON.parse(a).map((x: { phase: number }) => x.phase),
    );

    // 非整数种子取整，NaN 静默忽略
    rt.controllers.spectrum.randomSeaState(7.6);
    expect(deps.store.getState().params.spectrum.randomSeed).toBe(8);
    const before = JSON.stringify(waveField.components());
    rt.controllers.spectrum.randomSeaState(Number.NaN);
    expect(JSON.stringify(waveField.components())).toBe(before);
  });

  it('未知海况开关（mystery）状态存放于 store，且不影响物理计算', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store, waveField } = deps;

    rt.controllers.spectrum.setParam('windSpeed', 15);
    const hsBefore = waveField.observedSeaState().hs;

    rt.controllers.spectrum.setParam('mystery', true);
    expect(store.getState().params.spectrum.mystery).toBe(true);
    expect(rt.controllers.spectrum.observables().mystery).toBe(true);
    expect(waveField.observedSeaState().hs).toBeCloseTo(hsBefore, 9); // 物理照常

    rt.controllers.spectrum.setParam('mystery', false);
    expect(store.getState().params.spectrum.mystery).toBe(false);
  });

  it('谱型与 γ 真实改变谱形：γ 从 1→7 时峰处谱值恰放大 7 倍', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { waveField } = deps;

    // 集成仲裁（v0.2 谱模型，见 src/physics/MODELS.md §2）：JONSWAP 峰位由
    // 风区决定（fp=3.5(g/U)(gF/U²)^(-1/3)），与 PM 的 0.877g/2πU 不同——
    // 有限风区的 JONSWAP 谱峰能量可低于 PM 充分发展谱（物理正确），
    // 故谱型断言落在「峰位置真实改变」而非「峰值必高于 PM」。
    rt.controllers.spectrum.setParam('windSpeed', 12);
    const fpPm = pmPeakFrequency(12);
    const fpJonswap = jonswapPeakFrequency(12, DEFAULT_SIM_STATE.params.spectrum.fetch);
    expect(fpJonswap).toBeGreaterThan(fpPm); // 有限风区 ⇒ 谱峰偏高频

    rt.controllers.spectrum.setParam('kind', 'pm');
    const sPm = waveField.spectrum(fpPm);
    expect(sPm).toBeGreaterThan(0);
    expect(waveField.observedSeaState().peakFrequency).toBeCloseTo(fpPm, 9);

    rt.controllers.spectrum.setParam('kind', 'jonswap');
    const sJonswap = waveField.spectrum(fpJonswap);
    expect(sJonswap).toBeGreaterThan(0);
    // 谱型真实改变谱形：JONSWAP 峰在其自身峰频率处（远高于偏离峰的取值）
    expect(sJonswap).toBeGreaterThan(waveField.spectrum(fpPm));
    expect(waveField.observedSeaState().peakFrequency).toBeCloseTo(fpJonswap, 9);

    // 峰处 Γ(fp)=1 ⇒ S(fp) ∝ γ：γ 1→7 恰好 7 倍（同 α 下精确成立）
    rt.controllers.spectrum.setParam('peakEnhancement', 1);
    const s1 = waveField.spectrum(fpJonswap);
    rt.controllers.spectrum.setParam('peakEnhancement', 7);
    const s7 = waveField.spectrum(fpJonswap);
    expect(s7 / s1).toBeCloseTo(7, 6);
  });
});

// ========== 3. 风浪发展状态分类阈值边界 ==========

describe('风浪发展状态分类阈值边界', () => {
  it('纯函数逐点边界表', () => {
    const cases: Array<
      [number, number, ReturnType<typeof classifyWindDevelopment>]
    > = [
      [0, 30, 'calm'], // U < 0.3
      [0.29, 30, 'calm'],
      [30, 0, 'calm'], // 风时 0 优先（physics 无分量）
      [0, 0, 'calm'],
      [0.3, 1, 'capillary'], // U = 0.3 进入毛细波
      [1.99, 1, 'capillary'],
      [2, 1, 'developing'], // U ≥ 2 且风时 < 30
      [2, 29, 'developing'],
      [14.99, 5, 'developing'],
      [2, 30, 'mature'], // 风时 ≥ 30 成熟
      [14.99, 30, 'mature'],
      [15, 1, 'whitecap'], // U ≥ 15 白帽（优先于成熟段）
      [23.99, 1, 'whitecap'],
      [24, 0, 'calm'], // 风时 0 仍平静
      [24, 10, 'breaking'], // U ≥ 24 局部破碎
      [30, 60, 'breaking'],
    ];
    for (const [speed, duration, expected] of cases) {
      expect(classifyWindDevelopment(windParams(speed, duration))).toBe(
        expected,
      );
    }
  });

  it('分类经 observables 出口一致，中文名齐备', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);

    rt.setParams({ wind: windParams(0, 0) });
    let obs = rt.controllers.wind.observables();
    expect(obs.developmentState).toBe('calm');
    expect(obs.developmentLabel).toBe('平静');

    rt.setParams({ wind: windParams(16, 30) });
    obs = rt.controllers.wind.observables();
    expect(obs.developmentState).toBe('whitecap');
    expect(obs.developmentLabel).toBe('白帽');

    // 六态标签全覆盖
    expect(Object.keys(WIND_DEVELOPMENT_LABELS).sort()).toEqual(
      ['breaking', 'calm', 'capillary', 'developing', 'mature', 'whitecap'].sort(),
    );
    expect(Object.values(WIND_DEVELOPMENT_LABELS).every((s) => s.length > 0)).toBe(
      true,
    );
  });
});

// ========== 4. createExperiments 门面 ==========

describe('createExperiments 门面', () => {
  it('selectExperiment：状态切换 + 事件恰好一次 + 物理切到谱海况', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store, waveField } = deps;

    let changed = 0;
    store.on(STORE_EVENTS.EXPERIMENT_CHANGED, () => (changed += 1));

    rt.selectExperiment('wind'); // 同 id：no-op
    expect(changed).toBe(0);

    rt.selectExperiment('spectrum');
    expect(changed).toBe(1);
    expect(store.getState().experiment).toBe('spectrum');
    expect(
      waveField.spectrum(waveField.observedSeaState().peakFrequency),
    ).toBeGreaterThan(0); // 物理已切到实验三

    rt.selectExperiment('wind');
    expect(changed).toBe(2);
    expect(waveField.spectrum(0.15)).toBe(0); // 实验一非谱海况

    // 非法 id 忽略：不抛错、不发事件、状态不变
    expect(() =>
      rt.selectExperiment('storm' as ExperimentId),
    ).not.toThrow();
    expect(changed).toBe(2);
    expect(store.getState().experiment).toBe('wind');
  });

  it('setParams 深合并：部分分支 patch 不清空其他分支；事件恰好一次', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store } = deps;

    let events = 0;
    store.on(STORE_EVENTS.PARAMS_CHANGED, () => (events += 1));

    // 运行时容忍"部分分支"（UI 可能直写 store）：cast 模拟
    const partial = {
      interference: {
        makerA: { amplitude: 1.2, period: 4, angle: 0, phase: 90 },
      },
    } as unknown as Partial<SimParams>;
    rt.setParams(partial);

    expect(events).toBe(1);
    const p = store.getState().params;
    expect(p.interference.makerA.amplitude).toBe(1.2);
    expect(p.interference.makerA.phase).toBe(90);
    expect(p.interference.makerB).toEqual(DEFAULT_SIM_STATE.params.interference.makerB); // 未被清空
    expect(p.wind).toEqual(DEFAULT_SIM_STATE.params.wind);

    // 类型化完整分支 patch
    rt.setParams({ wind: windParams(20, 10, 45) });
    expect(events).toBe(2);
    expect(store.getState().params.wind).toEqual(windParams(20, 10, 45));
  });

  it('reset：时钟归零 + 测量清空 + 物理重新 configure', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store, waveField, clock } = deps;

    rt.selectExperiment('spectrum');
    clock.advance(2);
    expect(clock.time()).toBeGreaterThan(0);
    store.setState({
      measurements: [
        {
          id: 'm1',
          tool: 'wave-ruler' as const,
          simTime: 1,
          values: { eta: 0.3 },
        },
      ],
    });

    rt.reset();

    expect(clock.time()).toBe(0);
    expect(store.getState().measurements).toEqual([]);
    expect(
      waveField.spectrum(waveField.observedSeaState().peakFrequency),
    ).toBeGreaterThan(0); // 重新 configure 后物理仍与参数一致
  });

  it('update(dt) 由 clock.onStep 驱动：累计激活时长真实增长，切实验后清零', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { clock } = deps;

    clock.advance(1); // ≈60 固定步（accumulator 浮点边界允许 ±1 步）
    expect(rt.controllers.wind.observables().elapsedSinceActivate).toBeCloseTo(1, 1);

    rt.selectExperiment('interference');
    expect(rt.controllers.interference.observables().elapsedSinceActivate).toBe(0);
    clock.advance(0.5);
    expect(rt.controllers.interference.observables().elapsedSinceActivate).toBeCloseTo(0.5, 1);
    expect(rt.controllers.wind.observables().elapsedSinceActivate).toBeCloseTo(1, 1); // 停用后不再累计
  });

  it('实验二『恢复默认』：参数与物理分量同时回到默认', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store, waveField } = deps;

    rt.selectExperiment('interference');
    rt.controllers.interference.setParam('makerA.amplitude', 2);
    rt.controllers.interference.setParam('makerB.phase', 180);
    rt.controllers.interference.setParam('makerB.period', 9);

    rt.controllers.interference.resetParams();

    expect(store.getState().params.interference).toEqual(
      DEFAULT_SIM_STATE.params.interference,
    );
    const comps = waveField.components();
    expect(comps[0]?.amp).toBe(0.25);
    expect(comps[1]?.amp).toBe(0.25);
    expect(comps[1]?.phase).toBe(0);
    expect(comps[1]?.omega).toBeCloseTo((2 * Math.PI) / 4, 9);
  });

  it('外部直写 store + emit（SPEC §8 闭环）：clamp 校验并 configure 物理写入口唯一', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { store, waveField } = deps;

    rt.controllers.wind.setParam('windDuration', 30);

    const cur = store.getState().params;
    store.setState({
      params: { ...cur, wind: { ...cur.wind, windSpeed: 99 } }, // 越界直写
    });
    store.emit(STORE_EVENTS.PARAMS_CHANGED);

    expect(store.getState().params.wind.windSpeed).toBe(30); // 静默修正
    // 集成仲裁（v0.2 成长模型，见 src/physics/MODELS.md §2）：理论 Hs 来自
    // SPM/JONSWAP 风时/风区幂律 + 充分发展封顶（替换骨架公式 0.21U²/g）
    const expected = windGrowth(30, 30, WIND_TEACHING_FETCH);
    expect(waveField.observedSeaState().hs).toBeCloseTo(expected.hs, 9); // 物理已按修正值重建
  });

  it('dispose：退订时钟与事件，帧驱动停止', () => {
    const deps = makeDeps();
    const rt = createExperiments(deps);
    const { clock } = deps;

    rt.dispose();
    clock.advance(1);
    expect(rt.controllers.wind.observables().elapsedSinceActivate).toBe(0);
    expect(() => rt.dispose()).not.toThrow(); // 幂等
  });
});
