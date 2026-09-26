/**
 * 实验层模块私有类型 —— 仅 src/experiments 内部与集成装配期使用。
 * 跨模块共享类型一律以 core/types 为准（docs/SPEC.md §7.1：
 * 其他 feature 模块不得运行时 import 本目录；schema 数据建议由
 * 集成工程师在 main.ts 装配期注入 UI 面板）。
 */
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { ExperimentId, SimParams, SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';

// ========== 参数 schema（UI 据此自动渲染滑块 / 开关 / 单选） ==========

interface ParamItemBase {
  /** 参数键：相对当前实验参数分支的路径，如 'windSpeed'、'makerA.amplitude' */
  key: string;
  /** 中文标签（UI 直接显示） */
  label: string;
  /** true = 仅高级模式显示；缺省为基础参数 */
  advanced?: boolean;
}

/** 滑块参数（缺省控件类型） */
export interface SliderParamItem extends ParamItemBase {
  control?: 'slider';
  min: number;
  max: number;
  step: number;
  /** 计量单位（无量纲用空字符串） */
  unit: string;
  default: number;
}

/** 开关参数（布尔） */
export interface ToggleParamItem extends ParamItemBase {
  control: 'toggle';
  default: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

/** 单选参数（枚举） */
export interface SelectParamItem extends ParamItemBase {
  control: 'select';
  default: string;
  options: readonly SelectOption[];
}

export type ParamSchemaItem = SliderParamItem | ToggleParamItem | SelectParamItem;

// ========== 风浪发展状态 ==========

/**
 * 实验一发展状态分类（供 UI 与任务判定）。
 * 阈值见 windState.ts，与 SPEC §9.1 形态连续谱一致。
 */
export type WindDevelopmentState =
  | 'calm'
  | 'capillary'
  | 'developing'
  | 'mature'
  | 'whitecap'
  | 'breaking';

// ========== 观测量与控制器统一接口 ==========

/** 观测量：键名英文、值仅基础类型，供 UI / 图表 / 任务只读消费 */
export type ExperimentObservables = Record<string, number | string | boolean>;

/**
 * 实验引擎：参数落库 + store 事件 + 物理生效的唯一通道。
 * 由 createExperiments 统一装配（SPEC §6.2 参数变更流），
 * 控制器只经引擎提交参数，不直接触碰 waveField。
 */
export interface ExperimentEngine {
  /** store.setState({params}) → emit(PARAMS_CHANGED) → waveField.configure（幂等） */
  commit(experiment: ExperimentId, params: SimParams): void;
  /** 幂等 configure：实验与参数签名未变时跳过重复重建 */
  configure(experiment: ExperimentId, params: SimParams): void;
  /** 强制 configure（忽略幂等签名），用于 reset 的"重新 configure"语义 */
  reconfigure(experiment: ExperimentId, params: SimParams): void;
  /** store.setState({experiment}) → emit(EXPERIMENT_CHANGED) */
  select(experiment: ExperimentId): void;
}

export interface ExperimentControllerDeps {
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
  engine: ExperimentEngine;
}

/**
 * 单实验控制器统一接口（交付契约）：
 * paramSchema / activate / deactivate / setParam / update(dt) / observables / resetParams。
 * setParam 须在同一帧内写 physics 与 SimState（commit 内同步 configure）。
 */
export interface ExperimentController {
  readonly id: ExperimentId;
  /** 中文实验名 */
  readonly label: string;
  /** 参数 schema（UI 据此自动渲染控件） */
  readonly paramSchema: readonly ParamSchemaItem[];
  /** 激活：使 physics 与当前 store 参数一致 */
  activate(): void;
  /** 停用（实验切换编排由 createExperiments 统一负责） */
  deactivate(): void;
  /** 设置单个参数：clamp → 写 store → emit(PARAMS_CHANGED) → physics 同帧生效；未知键静默忽略 */
  setParam(key: string, value: number | boolean | string): void;
  /** 每个固定仿真步被调用一次（clock.onStep 驱动，渲染主循环是唯一帧驱动） */
  update(dt: number): void;
  /** 只读观测量（物理值实时从 waveField 读取）。生产 UI 不读此 API，主要供测试观察内部状态 */
  observables(): ExperimentObservables;
  /** 恢复本实验默认参数（实验二仅提供『恢复默认』，不提供解谜答案预设） */
  resetParams(): void;
}

export interface WindExperimentController extends ExperimentController {
  readonly id: 'wind';
}

export interface InterferenceExperimentController extends ExperimentController {
  readonly id: 'interference';
}

export interface SpectrumExperimentController extends ExperimentController {
  readonly id: 'spectrum';
  /** 任务六配套：按种子重摆随机海况（同种子 ⇒ 同一海况，保证可复现） */
  randomSeaState(seed: number): void;
}
