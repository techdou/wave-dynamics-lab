/**
 * 三实验参数 schema（实验层侧）。
 * 消费方：各控制器构造参数（controller.paramSchema）与 tests/experiments.test.ts
 * 的 schema↔PARAM_LIMITS 一致性校验。注意：UI 滑块渲染用的是
 * src/ui/logic/paramSchema.ts（自建，min/max 同源 PARAM_LIMITS）——两处
 * label/step 各自维护，修改任一侧时须同步检查另一侧。
 *
 * 范围与默认值来源：
 *   - min/max 严格取自 core/constants PARAM_LIMITS（滑块与 clamp 唯一来源，SPEC §5.4）；
 *   - default 取自 DEFAULT_SIM_STATE.params（与 store 初始状态同源，杜绝两处漂移）。
 * 键路径即 setParam 的 key：实验一直接字段名；实验二 'makerA.amplitude' 等；
 * 实验三直接字段名。
 *
 * 说明：实验二周期范围按 SPEC §9.2 / PARAM_LIMITS 为 0.5–20 s；
 * 实验三的高级模式含 γ / 随机种子 / 谱型 / 未知海况开关
 * （基础量 Hs、Tp 属于观测量，见各控制器 observables —— SPEC §9.3 的
 * 物理驱动参数是 U 与风区 F，类型契约 SimParams.spectrum 未设 Hs/Tp 直控字段）。
 */
import { DEFAULT_SIM_STATE } from '../core/constants';
import type { ExperimentId } from '../core/types';
import type { ParamSchemaItem } from './types';

/** 实验一 · 风浪生成机制 */
export const WIND_PARAM_SCHEMA: readonly ParamSchemaItem[] = [
  {
    key: 'windSpeed',
    label: '风速 U',
    min: 0,
    max: 30,
    step: 0.5,
    unit: 'm/s',
    default: DEFAULT_SIM_STATE.params.wind.windSpeed,
  },
  {
    key: 'windDuration',
    label: '风时',
    min: 0,
    max: 60,
    step: 1,
    unit: 'min',
    default: DEFAULT_SIM_STATE.params.wind.windDuration,
  },
  {
    key: 'windDirection',
    label: '风向',
    min: 0,
    max: 360,
    step: 5,
    unit: '°',
    default: DEFAULT_SIM_STATE.params.wind.windDirection,
    advanced: true, // 高级模式开放
  },
];

/** 实验二 · 双造波机叠加（两台独立，仅『恢复默认』，无解谜答案预设） */
export const INTERFERENCE_PARAM_SCHEMA: readonly ParamSchemaItem[] = [
  {
    key: 'makerA.amplitude',
    label: '造波机 A 波高 H₁',
    min: 0.05,
    max: 2,
    step: 0.05,
    unit: 'm',
    default: DEFAULT_SIM_STATE.params.interference.makerA.amplitude,
  },
  {
    key: 'makerA.period',
    label: '造波机 A 周期 T₁',
    min: 0.5,
    max: 20,
    step: 0.1,
    unit: 's',
    default: DEFAULT_SIM_STATE.params.interference.makerA.period,
  },
  {
    key: 'makerA.angle',
    label: '造波机 A 方向 θ₁',
    min: 0,
    max: 360,
    step: 5,
    unit: '°',
    default: DEFAULT_SIM_STATE.params.interference.makerA.angle,
  },
  {
    key: 'makerA.phase',
    label: '造波机 A 初相位 φ₁',
    min: 0,
    max: 360,
    step: 5,
    unit: '°',
    default: DEFAULT_SIM_STATE.params.interference.makerA.phase,
  },
  {
    key: 'makerB.amplitude',
    label: '造波机 B 波高 H₂',
    min: 0.05,
    max: 2,
    step: 0.05,
    unit: 'm',
    default: DEFAULT_SIM_STATE.params.interference.makerB.amplitude,
  },
  {
    key: 'makerB.period',
    label: '造波机 B 周期 T₂',
    min: 0.5,
    max: 20,
    step: 0.1,
    unit: 's',
    default: DEFAULT_SIM_STATE.params.interference.makerB.period,
  },
  {
    key: 'makerB.angle',
    label: '造波机 B 方向 θ₂',
    min: 0,
    max: 360,
    step: 5,
    unit: '°',
    default: DEFAULT_SIM_STATE.params.interference.makerB.angle,
  },
  {
    key: 'makerB.phase',
    label: '造波机 B 初相位 φ₂',
    min: 0,
    max: 360,
    step: 5,
    unit: '°',
    default: DEFAULT_SIM_STATE.params.interference.makerB.phase,
  },
];

/** 实验三 · 不规则随机海况 */
export const SPECTRUM_PARAM_SCHEMA: readonly ParamSchemaItem[] = [
  {
    key: 'windSpeed',
    label: '风速 U（19.5 m 高度等效）',
    min: 2,
    max: 30,
    step: 0.5,
    unit: 'm/s',
    default: DEFAULT_SIM_STATE.params.spectrum.windSpeed,
  },
  {
    key: 'fetch',
    label: '风区长度 F',
    min: 10000,
    max: 300000,
    step: 5000,
    unit: 'm',
    default: DEFAULT_SIM_STATE.params.spectrum.fetch,
  },
  {
    key: 'kind',
    label: '谱型',
    control: 'select',
    default: DEFAULT_SIM_STATE.params.spectrum.kind,
    options: [
      { value: 'pm', label: 'PM 谱' },
      { value: 'jonswap', label: 'JONSWAP 谱' },
    ],
    advanced: true,
  },
  {
    key: 'peakEnhancement',
    label: '谱峰增强因子 γ',
    min: 1,
    max: 7,
    step: 0.1,
    unit: '',
    default: DEFAULT_SIM_STATE.params.spectrum.peakEnhancement,
    advanced: true,
  },
  {
    key: 'randomSeed',
    label: '随机相位种子',
    min: 0,
    max: 99999,
    step: 1,
    unit: '',
    default: DEFAULT_SIM_STATE.params.spectrum.randomSeed,
    advanced: true,
  },
  {
    key: 'mystery',
    label: '未知海况模式（隐藏理论值，任务六）',
    control: 'toggle',
    default: DEFAULT_SIM_STATE.params.spectrum.mystery,
    advanced: true,
  },
];

/** 三实验 schema 总表（键为 ExperimentId） */
export const EXPERIMENT_PARAM_SCHEMAS: Readonly<
  Record<ExperimentId, readonly ParamSchemaItem[]>
> = {
  wind: WIND_PARAM_SCHEMA,
  interference: INTERFERENCE_PARAM_SCHEMA,
  spectrum: SPECTRUM_PARAM_SCHEMA,
};

/** 实验中文名（UI 顶栏 / 面板标题用） */
export const EXPERIMENT_LABELS: Readonly<Record<ExperimentId, string>> = {
  wind: '实验一 · 风浪生成机制',
  interference: '实验二 · 双造波机叠加',
  spectrum: '实验三 · 不规则随机海况',
};
