/**
 * 测量记录参数快照（纯函数）—— SPEC §10：每次测量"含时间与参数快照"。
 * 快照写入 MeasurementRecord.note（文本），键值读数写入 values。
 */
import type { ExperimentId, SimParams } from '../core/types';

const DEG = '°';

export function paramsSnapshotNote(
  experiment: ExperimentId,
  params: SimParams,
): string {
  switch (experiment) {
    case 'wind': {
      const w = params.wind;
      return `实验一·风浪 U=${w.windSpeed}m/s 风时=${w.windDuration}min 风向=${w.windDirection}${DEG}`;
    }
    case 'interference': {
      const a = params.interference.makerA;
      const b = params.interference.makerB;
      const fmt = (m: typeof a): string =>
        `H=${m.amplitude}m T=${m.period}s θ=${m.angle}${DEG} φ=${m.phase}${DEG}`;
      return `实验二·叠加 A(${fmt(a)}) B(${fmt(b)})`;
    }
    case 'spectrum': {
      const s = params.spectrum;
      return `实验三·谱 ${s.kind.toUpperCase()} U=${s.windSpeed}m/s F=${s.fetch}m γ=${s.peakEnhancement} seed=${s.randomSeed}${s.mystery ? ' [未知海况]' : ''}`;
    }
  }
}

/** 仪器中文名（UI 与记录摘要共用） */
export function instrumentLabel(tool: 'wave-ruler' | 'stopwatch' | 'drifter-buoy'): string {
  switch (tool) {
    case 'wave-ruler':
      return '波高尺';
    case 'stopwatch':
      return '秒表';
    case 'drifter-buoy':
      return '观测浮标';
  }
}

/** 单条测量记录的一行摘要（数据面板列表用，纯函数可测） */
export function summarizeRecord(
  tool: 'wave-ruler' | 'stopwatch' | 'drifter-buoy',
  values: Record<string, number>,
  simTime: number,
): string {
  const err =
    typeof values.errorPct === 'number' && Number.isFinite(values.errorPct)
      ? `（误差 ${values.errorPct.toFixed(1)}%）`
      : '';
  const v = (key: string): string =>
    typeof values[key] === 'number' && Number.isFinite(values[key])
      ? values[key].toFixed(2)
      : '—';
  switch (tool) {
    case 'wave-ruler':
      return `t=${simTime.toFixed(1)}s 波高 ${v('waveHeight')}m ${err}`;
    case 'stopwatch':
      return `t=${simTime.toFixed(1)}s 周期 ${v('period')}s（${values.peakCount ?? '—'} 峰） ${err}`;
    case 'drifter-buoy':
      return `t=${simTime.toFixed(1)}s η ${v('eta')}m Hs≈${v('hsEstimate')}m T̂p≈${v('spectralPeakPeriod')}s`;
  }
}
