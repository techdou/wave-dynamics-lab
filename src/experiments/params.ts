/**
 * 实验参数工具：补全 / 清洗 / clamp / 深合并 / 相等比较 —— 实验层内部实现。
 * clamp 范围唯一来源：core/constants PARAM_LIMITS（docs/SPEC.md §5.4）；
 * 随机种子范围 PARAM_LIMITS 未收录，由本文件 MAX_RANDOM_SEED 补充约束。
 * 所有函数不抛错：非法输入回落到回退值（缺省用 DEFAULT_SIM_STATE），
 * 未知参数键返回 null 由调用方静默忽略 —— 与 SPEC §6.2"不抛错"精神一致。
 */
import { DEFAULT_SIM_STATE, PARAM_LIMITS } from '../core/constants';
import type { Store } from '../core/store';
import type {
  ExperimentId,
  SimParams,
  SimState,
  SpectrumExperimentParams,
  SpectrumKind,
  WaveMakerParams,
  WindExperimentParams,
} from '../core/types';
import type { ExperimentEngine } from './types';

/** 随机相位种子上限（整数 [0, MAX_RANDOM_SEED]，实验层补充约束） */
export const MAX_RANDOM_SEED = 99999;

type LooseRecord = Record<string, unknown>;

// ---------- 基础清洗 ----------

function clampValue(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return clampValue(n, min, max);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return clampValue(Math.round(n), min, max);
}

function pickNum(
  obj: LooseRecord | null,
  key: string,
  fallback: number,
): number {
  if (!obj) return fallback;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function pickBool(
  obj: LooseRecord | null,
  key: string,
  fallback: boolean,
): boolean {
  if (!obj) return fallback;
  const v = obj[key];
  return typeof v === 'boolean' ? v : fallback;
}

function readObj(src: LooseRecord | null, key: string): LooseRecord | null {
  if (!src) return null;
  const v = src[key];
  return typeof v === 'object' && v !== null ? (v as LooseRecord) : null;
}

// ---------- 分支 clamp ----------

function clampWind(w: WindExperimentParams): WindExperimentParams {
  return {
    windSpeed: clampNum(
      w.windSpeed,
      DEFAULT_SIM_STATE.params.wind.windSpeed,
      PARAM_LIMITS.wind.windSpeed[0],
      PARAM_LIMITS.wind.windSpeed[1],
    ),
    windDuration: clampNum(
      w.windDuration,
      DEFAULT_SIM_STATE.params.wind.windDuration,
      PARAM_LIMITS.wind.windDuration[0],
      PARAM_LIMITS.wind.windDuration[1],
    ),
    windDirection: clampNum(
      w.windDirection,
      DEFAULT_SIM_STATE.params.wind.windDirection,
      PARAM_LIMITS.wind.windDirection[0],
      PARAM_LIMITS.wind.windDirection[1],
    ),
  };
}

function clampMaker(m: WaveMakerParams): WaveMakerParams {
  return {
    amplitude: clampNum(
      m.amplitude,
      DEFAULT_SIM_STATE.params.interference.makerA.amplitude,
      PARAM_LIMITS.interference.amplitude[0],
      PARAM_LIMITS.interference.amplitude[1],
    ),
    period: clampNum(
      m.period,
      DEFAULT_SIM_STATE.params.interference.makerA.period,
      PARAM_LIMITS.interference.period[0],
      PARAM_LIMITS.interference.period[1],
    ),
    angle: clampNum(
      m.angle,
      DEFAULT_SIM_STATE.params.interference.makerA.angle,
      PARAM_LIMITS.interference.angle[0],
      PARAM_LIMITS.interference.angle[1],
    ),
    phase: clampNum(
      m.phase,
      DEFAULT_SIM_STATE.params.interference.makerA.phase,
      PARAM_LIMITS.interference.phase[0],
      PARAM_LIMITS.interference.phase[1],
    ),
  };
}

function clampSpectrumKind(v: unknown): SpectrumKind {
  return v === 'pm' || v === 'jonswap' ? v : DEFAULT_SIM_STATE.params.spectrum.kind;
}

function clampSpectrum(s: SpectrumExperimentParams): SpectrumExperimentParams {
  return {
    kind: clampSpectrumKind(s.kind),
    windSpeed: clampNum(
      s.windSpeed,
      DEFAULT_SIM_STATE.params.spectrum.windSpeed,
      PARAM_LIMITS.spectrum.windSpeed[0],
      PARAM_LIMITS.spectrum.windSpeed[1],
    ),
    fetch: clampNum(
      s.fetch,
      DEFAULT_SIM_STATE.params.spectrum.fetch,
      PARAM_LIMITS.spectrum.fetch[0],
      PARAM_LIMITS.spectrum.fetch[1],
    ),
    randomSeed: clampInt(s.randomSeed, DEFAULT_SIM_STATE.params.spectrum.randomSeed, 0, MAX_RANDOM_SEED),
    peakEnhancement: clampNum(
      s.peakEnhancement,
      DEFAULT_SIM_STATE.params.spectrum.peakEnhancement,
      PARAM_LIMITS.spectrum.peakEnhancement[0],
      PARAM_LIMITS.spectrum.peakEnhancement[1],
    ),
    mystery: typeof s.mystery === 'boolean' ? s.mystery : DEFAULT_SIM_STATE.params.spectrum.mystery,
  };
}

/** 全量 clamp（输入应为完整形状；非有限值回落 DEFAULT） */
export function clampParams(p: SimParams): SimParams {
  return {
    wind: clampWind(p.wind),
    interference: {
      makerA: clampMaker(p.interference.makerA),
      makerB: clampMaker(p.interference.makerB),
    },
    spectrum: clampSpectrum(p.spectrum),
  };
}

// ---------- 深合并（容忍部分分支 / 缺字段 / 非有限值） ----------

function pickMaker(
  obj: LooseRecord | null,
  fallback: WaveMakerParams,
): WaveMakerParams {
  return {
    amplitude: pickNum(obj, 'amplitude', fallback.amplitude),
    period: pickNum(obj, 'period', fallback.period),
    angle: pickNum(obj, 'angle', fallback.angle),
    phase: pickNum(obj, 'phase', fallback.phase),
  };
}

/**
 * 把 patch 深合并到 base 上并整体 clamp，返回完整合法参数。
 * patch 分支/字段可缺省；字段非有限或类型不符时保留 base 值。
 */
export function applyPatch(
  base: SimParams,
  patch: Partial<SimParams> | LooseRecord,
): SimParams {
  const src = patch as LooseRecord;
  const wIn = readObj(src, 'wind');
  const iIn = readObj(src, 'interference');
  const sIn = readObj(src, 'spectrum');
  return clampParams({
    wind: {
      windSpeed: pickNum(wIn, 'windSpeed', base.wind.windSpeed),
      windDuration: pickNum(wIn, 'windDuration', base.wind.windDuration),
      windDirection: pickNum(wIn, 'windDirection', base.wind.windDirection),
    },
    interference: {
      makerA: pickMaker(readObj(iIn, 'makerA'), base.interference.makerA),
      makerB: pickMaker(readObj(iIn, 'makerB'), base.interference.makerB),
    },
    spectrum: {
      kind: ((): SpectrumKind => {
        if (!sIn) return base.spectrum.kind;
        const v = sIn['kind'];
        return clampSpectrumKind(typeof v === 'string' ? v : base.spectrum.kind);
      })(),
      windSpeed: pickNum(sIn, 'windSpeed', base.spectrum.windSpeed),
      fetch: pickNum(sIn, 'fetch', base.spectrum.fetch),
      randomSeed: pickNum(sIn, 'randomSeed', base.spectrum.randomSeed),
      peakEnhancement: pickNum(sIn, 'peakEnhancement', base.spectrum.peakEnhancement),
      mystery: pickBool(sIn, 'mystery', base.spectrum.mystery),
    },
  });
}

// ---------- 逐字段相等比较 ----------

/** 参数深相等（逐字段；观测/任务判定依赖确定性，不用引用比较） */
export function paramsEqual(a: SimParams, b: SimParams): boolean {
  return (
    a.wind.windSpeed === b.wind.windSpeed &&
    a.wind.windDuration === b.wind.windDuration &&
    a.wind.windDirection === b.wind.windDirection &&
    a.interference.makerA.amplitude === b.interference.makerA.amplitude &&
    a.interference.makerA.period === b.interference.makerA.period &&
    a.interference.makerA.angle === b.interference.makerA.angle &&
    a.interference.makerA.phase === b.interference.makerA.phase &&
    a.interference.makerB.amplitude === b.interference.makerB.amplitude &&
    a.interference.makerB.period === b.interference.makerB.period &&
    a.interference.makerB.angle === b.interference.makerB.angle &&
    a.interference.makerB.phase === b.interference.makerB.phase &&
    a.spectrum.kind === b.spectrum.kind &&
    a.spectrum.windSpeed === b.spectrum.windSpeed &&
    a.spectrum.fetch === b.spectrum.fetch &&
    a.spectrum.randomSeed === b.spectrum.randomSeed &&
    a.spectrum.peakEnhancement === b.spectrum.peakEnhancement &&
    a.spectrum.mystery === b.spectrum.mystery
  );
}

// ---------- setParam / resetParams 组装 ----------

/**
 * 单参数键 → patch 对象。未知键返回 null（调用方静默忽略）。
 * 键路径约定与 schema 一致：实验一直接字段名；实验二 'makerA.amplitude'；
 * 实验三直接字段名。
 */
export function paramPatchFromKey(
  experiment: ExperimentId,
  key: string,
  value: number | boolean | string,
): LooseRecord | null {
  switch (experiment) {
    case 'wind':
      if (key === 'windSpeed') return { wind: { windSpeed: value } };
      if (key === 'windDuration') return { wind: { windDuration: value } };
      if (key === 'windDirection') return { wind: { windDirection: value } };
      return null;
    case 'interference': {
      const dot = key.indexOf('.');
      if (dot <= 0) return null;
      const maker = key.slice(0, dot);
      const field = key.slice(dot + 1);
      if (maker !== 'makerA' && maker !== 'makerB') return null;
      if (
        field === 'amplitude' ||
        field === 'period' ||
        field === 'angle' ||
        field === 'phase'
      ) {
        return { interference: { [maker]: { [field]: value } } };
      }
      return null;
    }
    case 'spectrum':
      if (
        key === 'windSpeed' ||
        key === 'fetch' ||
        key === 'randomSeed' ||
        key === 'peakEnhancement'
      ) {
        return { spectrum: { [key]: value } };
      }
      if (key === 'kind') return { spectrum: { kind: value } };
      if (key === 'mystery') return { spectrum: { mystery: value === true } };
      return null;
  }
}

/**
 * 构造控制器 setParam：clamp → 无实效变化则跳过 →
 * engine.commit（setState → emit(PARAMS_CHANGED) → configure，同帧生效）。
 */
export function makeSetParam(
  experiment: ExperimentId,
  store: Store<SimState>,
  engine: ExperimentEngine,
): (key: string, value: number | boolean | string) => void {
  return (key, value) => {
    const patch = paramPatchFromKey(experiment, key, value);
    if (!patch) return;
    const current = store.getState().params;
    const next = applyPatch(current, patch);
    if (paramsEqual(next, current)) return;
    engine.commit(experiment, next);
  };
}

/** 构造控制器 resetParams：仅恢复本实验分支为 DEFAULT_SIM_STATE 默认值 */
export function makeResetParams(
  experiment: ExperimentId,
  store: Store<SimState>,
  engine: ExperimentEngine,
): () => void {
  return () => {
    const current = store.getState().params;
    const d = DEFAULT_SIM_STATE.params;
    const next: SimParams =
      experiment === 'wind'
        ? { ...current, wind: { ...d.wind } }
        : experiment === 'interference'
          ? {
              ...current,
              interference: {
                makerA: { ...d.interference.makerA },
                makerB: { ...d.interference.makerB },
              },
            }
          : { ...current, spectrum: { ...d.spectrum } };
    if (paramsEqual(next, current)) return;
    engine.commit(experiment, next);
  };
}
