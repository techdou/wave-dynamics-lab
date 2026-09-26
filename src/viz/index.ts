/**
 * src/viz 公共出口 —— 科学图表实现（src/charts 契约的运行时承载层）。
 * 集成工程师按 SPEC 用 src/charts 的 createCharts 即可；需要底层工具时从这里 import。
 */
export { createRingBuffer, type RingBuffer } from './ringBuffer';
export {
  scanExtrema,
  type ExtremumMode,
  type TimeValueSample,
} from './sampleScan';
export {
  componentEnergyStems,
  type SpectralStemPoint,
} from './componentSpectrum';
export {
  formatFixed,
  formatPercent,
  formatSigned,
  niceCeil,
  niceTimeStep,
  percentError,
} from './chartMath';
export {
  createTimeSeriesChart,
  type TimeSeriesChart,
  type TimeSeriesChartOptions,
} from './timeSeriesChart';
export {
  createSpectrumChart,
  type SpectrumChart,
  type SpectrumChartOptions,
  type SpectrumCurvePoint,
  type SpectrumDrawData,
} from './spectrumChart';
export { createChartsRuntime, type ChartsRuntimeDeps } from './chartsImpl';
