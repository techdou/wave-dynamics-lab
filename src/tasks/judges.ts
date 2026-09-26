/**
 * 六个任务判定器 —— src/tasks 模块私有纯函数（docs/SPEC.md §7.5）。
 * 判定输入全部来自 store 测量记录与 physics 数据（WaveField 分量/强度/海况），
 * 不读任何 UI 状态；全部为确定性纯函数，供 tasks 工厂与 vitest 直接复用。
 */
import type { ExperimentId, MeasurementRecord, WaveMakerParams } from '../core/types';
import { TASK_THRESHOLDS } from './taskDefs';

/** 单项判定结果（UI 直接渲染 label + detail，颜色由 ok 决定） */
export interface JudgeCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** 一次完整判定：checks 全部 ok 才 passed；metrics 供报告与面板展示数值 */
export interface TaskJudgment {
  passed: boolean;
  checks: JudgeCheck[];
  metrics: Record<string, number>;
}

const EPS = 1e-9;

/** 圆周角差（deg）：结果 ∈ [0, 180]，正确处理 350° 与 10° 之类跨零情况 */
export function circularDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 相对差：|a − b| / 平均值，防零除 */
export function relativeDiff(a: number, b: number): number {
  const mean = Math.abs(a + b) / 2;
  return mean < EPS ? Math.abs(a - b) : Math.abs(a - b) / mean;
}

/** 拍周期理论值 T₁T₂/|T₁−T₂|；周期相等时为无穷大（不构成拍） */
export function beatPeriodSeconds(t1: number, t2: number): number {
  const dt = Math.abs(t1 - t2);
  return dt < EPS ? Number.POSITIVE_INFINITY : (t1 * t2) / dt;
}

/** 取记录列表中最近一条含指定数值键的记录值；无则 null */
export function latestRecordValue(
  records: readonly MeasurementRecord[],
  key: string,
): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    const v = rec?.values[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** 双造波机公共输入（由 tasks 工厂从 waveField.components() 反推，见 makersFromField） */
export interface TwoWaveInput {
  makerA: WaveMakerParams;
  makerB: WaveMakerParams;
}

// ============================================================
// 任务一 · 白帽浪观测
// ============================================================

export interface WhitecapJudgeInput {
  experiment: ExperimentId;
  windSpeed: number;
  whitecapIntensity: number;
  /** 达标状态已稳定保持的仿真秒数（防误触观测时长） */
  sustainedSeconds: number;
  /** 当前波场下有效的 wave-ruler 记录条数（已按分量指纹过滤陈旧记录） */
  freshRulerCount: number;
}

export function judgeWhitecap(input: WhitecapJudgeInput): TaskJudgment {
  const th = TASK_THRESHOLDS.whitecap;
  const inRange =
    input.experiment === 'wind' &&
    input.windSpeed >= th.minWindSpeed - EPS &&
    input.windSpeed <= th.maxWindSpeed + EPS;
  const intensityOk = input.whitecapIntensity >= th.minIntensity - EPS;
  const sustainedOk = input.sustainedSeconds >= th.sustainedSeconds - EPS;
  const rulerOk = input.freshRulerCount >= 1;
  return {
    passed: inRange && intensityOk && sustainedOk && rulerOk,
    checks: [
      {
        id: 'wind-range',
        label: '风速处于白帽区间（15–30 m/s）',
        ok: inRange,
        detail: `当前风速 ${input.windSpeed.toFixed(1)} m/s`,
      },
      {
        id: 'intensity',
        label: `白帽强度 ≥ ${th.minIntensity}`,
        ok: intensityOk,
        detail: `当前强度 ${input.whitecapIntensity.toFixed(2)}（提高风速可增大强度；风时过长海况趋于平缓，强度可能回落）`,
      },
      {
        id: 'observation',
        label: `强度达标持续约 ${th.sustainedSeconds} 秒`,
        ok: sustainedOk,
        detail: `已持续 ${input.sustainedSeconds.toFixed(1)} s / ${th.sustainedSeconds} s（观测时间不足不判定通过）`,
      },
      {
        id: 'ruler-record',
        label: '已用波高尺记录一次测量',
        ok: rulerOk,
        detail: rulerOk
          ? `当前波场下有效记录 ${input.freshRulerCount} 条`
          : '尚未记录，或记录产生于参数调整之前（已过期）',
      },
    ],
    metrics: {
      windSpeed: input.windSpeed,
      intensity: input.whitecapIntensity,
      sustainedSeconds: input.sustainedSeconds,
    },
  };
}

// ============================================================
// 任务二 · 相长干涉（振幅最大）
// ============================================================

export interface AmplitudeJudgeInput extends TwoWaveInput {
  /** 达标参数配置已稳定保持的仿真秒数 */
  sustainedSeconds: number;
  /** 当前波场下有效的 wave-ruler 记录（取最近一条的 waveHeight 作峰谷差） */
  rulerRecords: readonly MeasurementRecord[];
}

/** 单列波的峰谷高差 = 波高 H（物理振幅 a = H/2，峰谷差 = 2a = H） */
function singleWaveTrough(m: WaveMakerParams): number {
  return Math.abs(m.amplitude);
}

export function judgeMaxAmplitude(input: AmplitudeJudgeInput): TaskJudgment {
  const th = TASK_THRESHOLDS["max-amplitude"];
  const samePeriod = relativeDiff(input.makerA.period, input.makerB.period) <= th.periodRelTol + EPS;
  const sameDirection =
    circularDiffDeg(input.makerA.angle, input.makerB.angle) <= th.angleTolDeg + EPS;
  const single = Math.max(singleWaveTrough(input.makerA), singleWaveTrough(input.makerB));
  const required = single * th.peakTroughFactor;
  const measured = latestRecordValue(input.rulerRecords, 'waveHeight');
  const measuredOk = measured !== null && measured >= required - EPS;
  const sustainedOk = input.sustainedSeconds >= th.sustainedSeconds - EPS;
  const ratio = measured !== null && single > EPS ? measured / single : 0;
  return {
    passed: samePeriod && sameDirection && measuredOk && sustainedOk,
    checks: [
      {
        id: 'same-period',
        label: `两波同频（|ΔT|/T̄ ≤ ${th.periodRelTol}）`,
        ok: samePeriod,
        detail: `T_A = ${input.makerA.period.toFixed(2)} s，T_B = ${input.makerB.period.toFixed(2)} s`,
      },
      {
        id: 'same-direction',
        label: `两波同向（夹角 ≤ ${th.angleTolDeg}°）`,
        ok: sameDirection,
        detail: `θ_A = ${input.makerA.angle.toFixed(0)}°，θ_B = ${input.makerB.angle.toFixed(0)}°`,
      },
      {
        id: 'measurement',
        label: `测量峰谷差 ≥ 单列波 × ${th.peakTroughFactor}`,
        ok: measuredOk,
        detail:
          measured === null
            ? '尚未记录波高尺测量，或记录已过期（参数调整后需重测）'
            : `测量 ${measured.toFixed(2)} m，需 ≥ ${required.toFixed(2)} m（单列波 ${single.toFixed(2)} m），倍率 ${ratio.toFixed(2)}`,
      },
      {
        id: 'observation',
        label: `相位对齐状态保持约 ${th.sustainedSeconds} 秒`,
        ok: sustainedOk,
        detail: `已保持 ${input.sustainedSeconds.toFixed(1)} s / ${th.sustainedSeconds} s`,
      },
    ],
    metrics: {
      measuredPeakTrough: measured ?? Number.NaN,
      requiredPeakTrough: required,
      ratioToSingle: ratio,
      sustainedSeconds: input.sustainedSeconds,
    },
  };
}

// ============================================================
// 任务三 · 相消干涉（振幅归零）
// ============================================================

export function judgeZeroAmplitude(input: AmplitudeJudgeInput): TaskJudgment {
  const th = TASK_THRESHOLDS["zero-amplitude"];
  const maxAmp = Math.max(singleWaveTrough(input.makerA), singleWaveTrough(input.makerB));
  const samePeriod = relativeDiff(input.makerA.period, input.makerB.period) <= th.periodRelTol + EPS;
  const ampMatch =
    maxAmp > EPS &&
    Math.abs(input.makerA.amplitude - input.makerB.amplitude) / maxAmp <=
      th.amplitudeRelTol + EPS;
  const phaseDiff = circularDiffDeg(input.makerA.phase, input.makerB.phase);
  const oppositePhase = Math.abs(phaseDiff - 180) <= th.phaseTolDeg + EPS;
  const required = maxAmp * th.residualFactor;
  const measured = latestRecordValue(input.rulerRecords, 'waveHeight');
  const residualOk = measured !== null && measured <= required + EPS;
  const sustainedOk = input.sustainedSeconds >= th.sustainedSeconds - EPS;
  return {
    passed: samePeriod && ampMatch && oppositePhase && residualOk && sustainedOk,
    checks: [
      {
        id: 'same-period',
        label: `两波同频（|ΔT|/T̄ ≤ ${th.periodRelTol}）`,
        ok: samePeriod,
        detail: `T_A = ${input.makerA.period.toFixed(2)} s，T_B = ${input.makerB.period.toFixed(2)} s`,
      },
      {
        id: 'amplitude-match',
        label: `振幅相等（差 ≤ ${th.amplitudeRelTol * 100}%）`,
        ok: ampMatch,
        detail: `H_A = ${input.makerA.amplitude.toFixed(2)} m，H_B = ${input.makerB.amplitude.toFixed(2)} m`,
      },
      {
        id: 'opposite-phase',
        label: `相位差 ≈ 180°（|Δφ − 180°| ≤ ${th.phaseTolDeg}°）`,
        ok: oppositePhase,
        detail: `当前相位差 ${phaseDiff.toFixed(0)}°`,
      },
      {
        id: 'measurement',
        label: `残余峰谷差 ≤ 单列波 × ${th.residualFactor}`,
        ok: residualOk,
        detail:
          measured === null
            ? '尚未记录波高尺测量，或记录已过期（参数调整后需重测）'
            : `残余 ${measured.toFixed(2)} m，需 ≤ ${required.toFixed(2)} m`,
      },
      {
        id: 'observation',
        label: `相消状态保持约 ${th.sustainedSeconds} 秒`,
        ok: sustainedOk,
        detail: `已保持 ${input.sustainedSeconds.toFixed(1)} s / ${th.sustainedSeconds} s`,
      },
    ],
    metrics: {
      residualPeakTrough: measured ?? Number.NaN,
      requiredResidual: required,
      phaseDiffDeg: phaseDiff,
      sustainedSeconds: input.sustainedSeconds,
    },
  };
}

// ============================================================
// 任务四 · 拍
// ============================================================

export interface BeatingJudgeInput extends TwoWaveInput {
  sustainedSeconds: number;
  /** 当前波场下有效的 stopwatch 记录（取最近一条的 beatingPeriod） */
  stopwatchRecords: readonly MeasurementRecord[];
}

export function judgeBeating(input: BeatingJudgeInput): TaskJudgment {
  const th = TASK_THRESHOLDS.beating;
  const meanPeriod = (input.makerA.period + input.makerB.period) / 2;
  const detune =
    meanPeriod > EPS ? Math.abs(input.makerA.period - input.makerB.period) / meanPeriod : 0;
  const detuneOk = detune >= th.detuneMin - EPS && detune <= th.detuneMax + EPS;
  const aA = input.makerA.amplitude / 2;
  const aB = input.makerB.amplitude / 2;
  const contrast =
    Math.abs(aA - aB) > EPS ? (aA + aB) / Math.abs(aA - aB) : Number.POSITIVE_INFINITY;
  const contrastOk = contrast >= th.envelopeContrastMin - EPS;
  const theoryBeat = beatPeriodSeconds(input.makerA.period, input.makerB.period);
  const measured = latestRecordValue(input.stopwatchRecords, 'beatingPeriod');
  const measuredOk =
    measured !== null &&
    Number.isFinite(theoryBeat) &&
    Math.abs(measured - theoryBeat) <= theoryBeat * th.beatPeriodRelTol + EPS;
  const sustainedOk = input.sustainedSeconds >= th.sustainedSeconds - EPS;
  return {
    passed: detuneOk && contrastOk && measuredOk && sustainedOk,
    checks: [
      {
        id: 'detune-band',
        label: `周期差小而非零（|ΔT|/T̄ ∈ [${th.detuneMin}, ${th.detuneMax}]）`,
        ok: detuneOk,
        detail: `T_A = ${input.makerA.period.toFixed(2)} s，T_B = ${input.makerB.period.toFixed(2)} s，失谐 ${detune.toFixed(2)}`,
      },
      {
        id: 'envelope-contrast',
        label: `包络起伏 ≥ ${th.envelopeContrastMin}:1`,
        ok: contrastOk,
        detail:
          Number.isFinite(contrast)
            ? `振幅比 ${contrast.toFixed(1)}:1（两振幅越接近起伏越深）`
            : '两振幅相等，包络可完全落到零（最佳）',
      },
      {
        id: 'beat-period',
        label: `测量拍周期 ≈ T₁T₂/|T₁−T₂|（±${th.beatPeriodRelTol * 100}%）`,
        ok: measuredOk,
        detail:
          measured === null
            ? '尚未用秒表记录 beatingPeriod，或记录已过期'
            : Number.isFinite(theoryBeat)
              ? `理论 ${theoryBeat.toFixed(1)} s，测量 ${measured.toFixed(1)} s`
              : '两周期相等，不存在拍',
      },
      {
        id: 'observation',
        label: `拍状态保持约 ${th.sustainedSeconds} 秒`,
        ok: sustainedOk,
        detail: `已保持 ${input.sustainedSeconds.toFixed(1)} s / ${th.sustainedSeconds} s`,
      },
    ],
    metrics: {
      detune,
      envelopeContrast: Number.isFinite(contrast) ? contrast : -1,
      theoryBeatSeconds: Number.isFinite(theoryBeat) ? theoryBeat : -1,
      measuredBeatSeconds: measured ?? Number.NaN,
      sustainedSeconds: input.sustainedSeconds,
    },
  };
}

// ============================================================
// 任务五 · 交叉格状波面（启发式判定）
// ============================================================

export interface GridJudgeInput extends TwoWaveInput {
  sustainedSeconds: number;
}

/** 任务五判定为启发式（UI 需向学生注明），阈值仅是近似准则 */
export const GRID_PATTERN_HEURISTIC = true;

export function judgeGridPattern(input: GridJudgeInput): TaskJudgment {
  const th = TASK_THRESHOLDS["grid-pattern"];
  const angleDiff = circularDiffDeg(input.makerA.angle, input.makerB.angle);
  const angleOk = angleDiff >= th.angleMinDeg - EPS && angleDiff <= th.angleMaxDeg + EPS;
  const amps = [input.makerA.amplitude, input.makerB.amplitude];
  const maxAmp = Math.max(...amps);
  const minAmp = Math.min(...amps);
  const visibleOk = maxAmp > EPS && minAmp / maxAmp >= th.visibilityRatio - EPS;
  const sustainedOk = input.sustainedSeconds >= th.sustainedSeconds - EPS;
  return {
    passed: angleOk && visibleOk && sustainedOk,
    checks: [
      {
        id: 'angle-band',
        label: `两波夹角 ∈ [${th.angleMinDeg}°, ${th.angleMaxDeg}°]`,
        ok: angleOk,
        detail: `θ_A = ${input.makerA.angle.toFixed(0)}°，θ_B = ${input.makerB.angle.toFixed(0)}°，夹角 ${angleDiff.toFixed(0)}°`,
      },
      {
        id: 'both-visible',
        label: '两列波均可见（启发式：弱波振幅 ≥ 强波的 20%）',
        ok: visibleOk,
        detail: `H_A = ${input.makerA.amplitude.toFixed(2)} m，H_B = ${input.makerB.amplitude.toFixed(2)} m`,
      },
      {
        id: 'observation',
        label: `图样观察约 ${th.sustainedSeconds} 秒后提交`,
        ok: sustainedOk,
        detail: `已观察 ${input.sustainedSeconds.toFixed(1)} s / ${th.sustainedSeconds} s`,
      },
    ],
    metrics: {
      angleDiffDeg: angleDiff,
      visibilityRatio: maxAmp > EPS ? minAmp / maxAmp : 0,
      sustainedSeconds: input.sustainedSeconds,
    },
  };
}

// ============================================================
// 任务六 · 未知海况还原
// ============================================================

export interface UnknownSeaJudgeInput {
  mysteryActive: boolean;
  truthHs: number;
  truthTp: number;
  /** 学生提交的估计值；未填为 null */
  estimate: { hs: number; tp: number } | null;
  freshRulerCount: number;
  freshStopwatchCount: number;
}

export function judgeUnknownSea(input: UnknownSeaJudgeInput): TaskJudgment {
  const th = TASK_THRESHOLDS["unknown-sea"];
  const hsErr =
    input.estimate && input.truthHs > EPS
      ? Math.abs(input.estimate.hs - input.truthHs) / input.truthHs
      : null;
  const tpErr =
    input.estimate && input.truthTp > EPS
      ? Math.abs(input.estimate.tp - input.truthTp) / input.truthTp
      : null;
  const hsOk = hsErr !== null && hsErr <= th.hsRelTol + EPS;
  const tpOk = tpErr !== null && tpErr <= th.tpRelTol + EPS;
  const metrics: Record<string, number> = {};
  if (hsErr !== null) metrics.hsErrorPct = hsErr * 100;
  if (tpErr !== null) metrics.tpErrorPct = tpErr * 100;
  return {
    passed:
      input.mysteryActive &&
      input.freshRulerCount >= 1 &&
      input.freshStopwatchCount >= 1 &&
      hsOk &&
      tpOk,
    checks: [
      {
        id: 'mystery',
        label: '处于未知海况模式（理论值已隐藏）',
        ok: input.mysteryActive,
        detail: input.mysteryActive ? '模式已开启' : '请在实验三开启"未知海况"模式后再提交',
      },
      {
        id: 'evidence-ruler',
        label: '已用波高尺测量（估计 Hs 的依据）',
        ok: input.freshRulerCount >= 1,
        detail:
          input.freshRulerCount >= 1
            ? `有效记录 ${input.freshRulerCount} 条`
            : '尚未测量，或记录产生于本海况生成之前',
      },
      {
        id: 'evidence-stopwatch',
        label: '已用秒表测量（估计 Tp 的依据）',
        ok: input.freshStopwatchCount >= 1,
        detail:
          input.freshStopwatchCount >= 1
            ? `有效记录 ${input.freshStopwatchCount} 条`
            : '尚未测量，或记录产生于本海况生成之前',
      },
      {
        id: 'hs-error',
        label: `Hs 估计误差 ≤ ${th.hsRelTol * 100}%`,
        ok: hsOk,
        detail:
          hsErr === null
            ? '尚未提交 Hs 估计值'
            : `误差 ${(hsErr * 100).toFixed(1)}%`,
      },
      {
        id: 'tp-error',
        label: `Tp 估计误差 ≤ ${th.tpRelTol * 100}%`,
        ok: tpOk,
        detail:
          tpErr === null
            ? '尚未提交 Tp 估计值'
            : `误差 ${(tpErr * 100).toFixed(1)}%`,
      },
    ],
    metrics,
  };
}
