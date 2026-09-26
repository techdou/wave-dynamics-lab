/**
 * 参数 schema → 控件映射（纯逻辑，可单测）
 * SPEC §9 要求"参数面板按 experiments 的 schema 自动渲染滑块"：
 * 数值范围的唯一来源是 core/constants 的 PARAM_LIMITS（与 physics clamp 同源），
 * 本模块只补充展示层信息（中文标签 / 单位 / 步进 / 控件种类 / 一行说明）。
 * 点分路径读写 SimParams 均为不可变操作，绝不原地修改 store 里的对象。
 */
import { PARAM_LIMITS } from '../../core/constants';
import type { ExperimentId, SimParams } from '../../core/types';

export type ParamControlKind = 'slider' | 'number' | 'select' | 'checkbox';

export interface ParamFieldOption {
  value: string;
  label: string;
}

export interface ParamField {
  /** 参数在 SimParams 中的点分路径，如 'wind.windSpeed'、'interference.makerA.phase' */
  path: string;
  /** 中文标签 */
  label: string;
  unit?: string;
  kind: ParamControlKind;
  min?: number;
  max?: number;
  step?: number;
  /** 整数输入（如随机种子、风区） */
  integer?: boolean;
  /** 控件下方的一行说明 */
  hint?: string;
  options?: readonly ParamFieldOption[];
}

export interface ParamGroup {
  id: string;
  title: string;
  fields: readonly ParamField[];
}

function makerFields(maker: 'makerA' | 'makerB'): ParamField[] {
  const prefix = `interference.${maker}`;
  return [
    {
      path: `${prefix}.amplitude`,
      label: '波高 H',
      unit: 'm',
      kind: 'slider',
      min: PARAM_LIMITS.interference.amplitude[0],
      max: PARAM_LIMITS.interference.amplitude[1],
      step: 0.05,
      hint: '内部波分量振幅 = H/2',
    },
    {
      path: `${prefix}.period`,
      label: '周期 T',
      unit: 's',
      kind: 'slider',
      min: PARAM_LIMITS.interference.period[0],
      max: PARAM_LIMITS.interference.period[1],
      step: 0.1,
    },
    {
      path: `${prefix}.angle`,
      label: '方向 θ',
      unit: '°',
      kind: 'slider',
      min: PARAM_LIMITS.interference.angle[0],
      max: PARAM_LIMITS.interference.angle[1],
      step: 5,
      hint: '0° = 沿 +y（北）传播',
    },
    {
      path: `${prefix}.phase`,
      label: '初相位 φ',
      unit: '°',
      kind: 'slider',
      min: PARAM_LIMITS.interference.phase[0],
      max: PARAM_LIMITS.interference.phase[1],
      step: 5,
    },
  ];
}

export function buildParamSchema(experiment: ExperimentId): readonly ParamGroup[] {
  switch (experiment) {
    case 'wind':
      return [
        {
          id: 'wind',
          title: '风场',
          fields: [
            {
              path: 'wind.windSpeed',
              label: '风速',
              unit: 'm/s',
              kind: 'slider',
              min: PARAM_LIMITS.wind.windSpeed[0],
              max: PARAM_LIMITS.wind.windSpeed[1],
              step: 0.5,
              hint: 'U ≥ 15 m/s 出现白帽，U ≥ 24 m/s 局部破碎',
            },
            {
              path: 'wind.windDuration',
              label: '风时',
              unit: 'min',
              kind: 'slider',
              min: PARAM_LIMITS.wind.windDuration[0],
              max: PARAM_LIMITS.wind.windDuration[1],
              step: 1,
              hint: '30 min 达到成熟风浪（教学约定）',
            },
            {
              path: 'wind.windDirection',
              label: '风向',
              unit: '°',
              kind: 'slider',
              min: PARAM_LIMITS.wind.windDirection[0],
              max: PARAM_LIMITS.wind.windDirection[1],
              step: 1,
              hint: '0° = 沿 +y（北）传播',
            },
          ],
        },
      ];
    case 'interference':
      return [
        { id: 'makerA', title: '造波机 A', fields: makerFields('makerA') },
        { id: 'makerB', title: '造波机 B', fields: makerFields('makerB') },
      ];
    case 'spectrum':
      return [
        {
          id: 'spectrum',
          title: '海浪谱',
          fields: [
            {
              path: 'spectrum.kind',
              label: '谱类型',
              kind: 'select',
              options: [
                { value: 'pm', label: 'PM 谱（Pierson–Moskowitz）' },
                { value: 'jonswap', label: 'JONSWAP 谱（教学版）' },
              ],
            },
            {
              path: 'spectrum.windSpeed',
              label: '风速 U',
              unit: 'm/s',
              kind: 'slider',
              min: PARAM_LIMITS.spectrum.windSpeed[0],
              max: PARAM_LIMITS.spectrum.windSpeed[1],
              step: 0.5,
              hint: '19.5 m 高度等效风速',
            },
            {
              path: 'spectrum.fetch',
              label: '风区 F',
              unit: 'm',
              kind: 'slider',
              min: PARAM_LIMITS.spectrum.fetch[0],
              max: PARAM_LIMITS.spectrum.fetch[1],
              step: 1000,
              integer: true,
              hint: '仅 JONSWAP 有效',
            },
            {
              path: 'spectrum.peakEnhancement',
              label: '峰升高因子 γ',
              kind: 'slider',
              min: PARAM_LIMITS.spectrum.peakEnhancement[0],
              max: PARAM_LIMITS.spectrum.peakEnhancement[1],
              step: 0.1,
              hint: 'PM 谱时忽略',
            },
            {
              path: 'spectrum.randomSeed',
              label: '随机种子',
              kind: 'number',
              min: 0,
              // 与实验层 MAX_RANDOM_SEED（params.ts）一致，避免输入被静默 clamp
              max: 99999,
              step: 1,
              integer: true,
              hint: '同种子 ⇒ 同一海况（可复现）',
            },
            {
              path: 'spectrum.mystery',
              label: '未知海况模式',
              kind: 'checkbox',
              hint: '隐藏理论海况值，供任务六测量估计',
            },
          ],
        },
      ];
  }
}

/** 展平为字段列表 */
export function flattenParamGroups(groups: readonly ParamGroup[]): ParamField[] {
  return groups.flatMap((group) => [...group.fields]);
}

/** 按路径查字段；schema 均为本模块静态定义，查不到说明调用方传错路径 */
export function getParamField(
  groups: readonly ParamGroup[],
  path: string,
): ParamField | undefined {
  return flattenParamGroups(groups).find((field) => field.path === path);
}

/** 读取点分路径下的标量值；路径不存在或指向非标量时抛错（调用方 schema 静态、路径可控） */
export function readParamPath(params: SimParams, path: string): number | string | boolean {
  let node: unknown = params;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(key in node)) {
      throw new Error(`参数路径不存在：${path}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') {
    return node;
  }
  throw new Error(`参数路径指向非标量值：${path}`);
}

function setDeep(
  node: Record<string, unknown>,
  keys: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const head = keys[0];
  if (head === undefined) return node;
  const rest = keys.slice(1);
  if (rest.length === 0) return { ...node, [head]: value };
  const child = node[head];
  const childObj =
    typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {};
  return { ...node, [head]: setDeep(childObj, rest, value) };
}

/** 不可变地写入点分路径，返回新的 SimParams（原对象不动） */
export function applyParamPath(
  params: SimParams,
  path: string,
  value: number | string | boolean,
): SimParams {
  return setDeep(params as unknown as Record<string, unknown>, path.split('.'), value) as unknown as SimParams;
}

/** 按字段约束裁剪数值：非有限值回落 min，整数取整，再夹到 [min, max] */
export function clampFieldValue(field: ParamField, value: number): number {
  if (!Number.isFinite(value)) return field.min ?? 0;
  let v = value;
  if (field.integer) v = Math.round(v);
  if (field.min !== undefined) v = Math.max(field.min, v);
  if (field.max !== undefined) v = Math.min(field.max, v);
  return v;
}

/** 由 step 推小数位数（用于数字框显示），无 step / 非有限值按 0 位 */
export function stepDecimals(step: number | undefined): number {
  if (step === undefined || !Number.isFinite(step)) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}
