/**
 * src/instruments 公共出口 —— 三种虚拟仪器。
 * 集成工程师按 SPEC 用 src/instruments/instruments.ts 的 createInstruments；
 * 需要 3D 浮标遥测（位置/拖尾/统计）时用本目录 runtime 的 createInstrumentsRuntime
 * （仅 main.ts 组装点可 import，运行期不与其他 feature 模块互通）。
 */
export {
  createStreamExtremaDetector,
  type ExtremumSample,
  type StreamExtremaDetector,
} from './peakDetector';
export {
  createStopwatchLogic,
  type StopwatchPhase,
  type StopwatchReading,
  type StopwatchLogic,
} from './stopwatch';
export {
  createWaveRulerLogic,
  type PickTroughResult,
  type WaveRulerLogic,
  type WaveRulerPhase,
  type WaveRulerState,
} from './waveRuler';
export {
  computeBuoyStats,
  emptyBuoyStats,
  spectralPeakEstimate,
  zeroUpCrossWaves,
  type BuoyEtaSample,
  type BuoyStats,
} from './buoyStats';
export {
  buoyPositionAt,
  mainWaveFromComponents,
  type MainWaveInfo,
} from './buoyKinematics';
export {
  instrumentLabel,
  paramsSnapshotNote,
  summarizeRecord,
} from './measurements';
export {
  createMeasurementsView,
  type MeasurementsView,
  type MeasurementsViewDeps,
} from './measurementsView';
export {
  createInstrumentsRuntime,
  type BuoyTelemetry,
  type BuoyTrailPoint,
  type InstrumentsRuntimeDeps,
  type InstrumentsWithTelemetry,
} from './runtime';
