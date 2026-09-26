/**
 * createExperiments —— docs/SPEC.md §6.2 契约实现（实验层工程师）。
 * 职责：唯一被允许调用 waveField.configure 的模块；实验切换、参数校验与
 * clamp、configure 编排。实现拆分为本目录内三个控制器 + 实验引擎：
 *   engine.ts        参数落库 → store 事件 → 物理生效（SPEC §8 顺序强制）
 *   windExperiment.ts        实验一 · 风浪生成机制
 *   interferenceExperiment.ts 实验二 · 双造波机叠加
 *   spectrumExperiment.ts     实验三 · 不规则随机海况（含 randomSeaState）
 *   schema.ts / windState.ts / interferenceMath.ts / params.ts
 *
 * 导出签名说明：ExperimentsDeps / Experiments 与骨架契约完全一致；
 * createExperiments 返回类型收窄为 ExperimentsRuntime（extends Experiments，
 * 仅追加只读 controllers 访问器，向后兼容——集成工程师经此触达每实验的
 * schema / setParam / observables / randomSeaState）。
 */
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { ExperimentId, SimParams, SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';
import { createExperimentEngine } from './engine';
import { applyPatch, paramsEqual } from './params';
import { createWindExperiment } from './windExperiment';
import { createInterferenceExperiment } from './interferenceExperiment';
import { createSpectrumExperiment } from './spectrumExperiment';
import type {
  WindExperimentController,
  InterferenceExperimentController,
  SpectrumExperimentController,
} from './types';

export interface ExperimentsDeps {
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
}

export interface Experiments {
  /**
   * 切换实验并按 PARAM_LIMITS 校验/裁剪参数，随后：
   * store.setState({ experiment }) → emit(EXPERIMENT_CHANGED) → waveField.configure
   */
  selectExperiment(id: ExperimentId): void;
  /**
   * 应用参数变更（深合并对应实验的参数分支），流程同上：
   * store.setState({ params }) → emit(PARAMS_CHANGED) → waveField.configure
   * 参数越界时以 PARAM_LIMITS clamp，不抛错。
   */
  setParams(patch: Partial<SimParams>): void;
  /** 实验重置：时钟归零 + 清空测量 + 当前实验参数重新 configure */
  reset(): void;
  dispose(): void;
}

/** 三实验控制器注册表 */
export type ExperimentControllers = Readonly<{
  wind: WindExperimentController;
  interference: InterferenceExperimentController;
  spectrum: SpectrumExperimentController;
}>;

/**
 * Experiments 契约的向后兼容扩展：追加只读控制器访问器。
 * 集成工程师经 controllers 触达每实验的 setParam / observables /
 * randomSeaState。参数 schema 分工：本目录 schema.ts 供控制器 paramSchema
 * 与测试一致性校验；UI 滑块渲染用 ui/logic/paramSchema.ts（min/max 同源
 * PARAM_LIMITS，SPEC §5.4），运行期通信仍走 store（SPEC §7.1）。
 */
export interface ExperimentsRuntime extends Experiments {
  readonly controllers: ExperimentControllers;
}

const EXPERIMENT_IDS: readonly ExperimentId[] = [
  'wind',
  'interference',
  'spectrum',
];

function isExperimentId(v: string): v is ExperimentId {
  return (EXPERIMENT_IDS as readonly string[]).includes(v);
}

export function createExperiments(deps: ExperimentsDeps): ExperimentsRuntime {
  const { store, waveField, clock } = deps;
  const engine = createExperimentEngine({ store, waveField });

  const controllers: {
    wind: WindExperimentController;
    interference: InterferenceExperimentController;
    spectrum: SpectrumExperimentController;
  } = {
    wind: createWindExperiment({ store, waveField, clock, engine }),
    interference: createInterferenceExperiment({
      store,
      waveField,
      clock,
      engine,
    }),
    spectrum: createSpectrumExperiment({ store, waveField, clock, engine }),
  };

  let active: ExperimentId = store.getState().experiment;

  // 注：参数外部直写闭环（PARAMS_CHANGED → clamp + configure）由 engine
  // 内部自行订阅，此处不再重复订阅（曾导致每次参数事件回调执行两遍）。

  // 帧驱动唯一入口：渲染主循环 → clock 固定步长 → 当前实验 update(dt)
  const offStep = clock.onStep(() => {
    controllers[active].update(clock.stepSeconds);
  });

  // 初始激活：进入应用即有物理波场（默认实验一 · 平静海面）
  controllers[active].activate();

  const runtime: ExperimentsRuntime = {
    controllers,

    selectExperiment(id: ExperimentId): void {
      if (!isExperimentId(id) || id === active) return;
      controllers[active].deactivate();
      active = id;
      engine.select(id); // setState({experiment}) → emit(EXPERIMENT_CHANGED)
      controllers[id].activate(); // activate 内 configure（事件之后，符合 §6.2 顺序）
    },

    setParams(patch: Partial<SimParams>): void {
      const { experiment, params } = store.getState();
      const next = applyPatch(params, patch);
      if (paramsEqual(next, params)) return; // 无实效变化不发事件
      engine.commit(experiment, next);
    },

    reset(): void {
      clock.reset();
      store.setState({ measurements: [] });
      // "重新 configure"：强制重建分量（忽略幂等签名）
      engine.reconfigure(active, store.getState().params);
    },

    dispose(): void {
      offStep();
      controllers[active].deactivate();
    },
  };

  return runtime;
}

// ========== 公共导出（集成 / UI 装配期单一入口） ==========

export {
  EXPERIMENT_PARAM_SCHEMAS,
  WIND_PARAM_SCHEMA,
  INTERFERENCE_PARAM_SCHEMA,
  SPECTRUM_PARAM_SCHEMA,
  EXPERIMENT_LABELS,
} from './schema';
export {
  classifyWindDevelopment,
  WIND_DEVELOPMENT_LABELS,
  WIND_CALM_SPEED_THRESHOLD,
  WIND_CAPILLARY_SPEED_MAX,
  WIND_MATURE_DURATION_MIN,
  WIND_WHITECAP_SPEED,
  WIND_BREAKING_SPEED,
} from './windState';
export type {
  ParamSchemaItem,
  SliderParamItem,
  ToggleParamItem,
  SelectParamItem,
  SelectOption,
  WindDevelopmentState,
  ExperimentObservables,
  ExperimentEngine,
  ExperimentController,
  WindExperimentController,
  InterferenceExperimentController,
  SpectrumExperimentController,
} from './types';
