/**
 * createInstruments 实现主体 —— src/instruments/instruments.ts 契约的运行时（SPEC §7.4）。
 * 三种虚拟仪器（波高尺 / 秒表 / 观测浮标）+ 测量记录写入 store + 面板交互 UI。
 * 驱动：clock.onStep 固定仿真步（60Hz）→ 探针 evalSurface → 流式峰/谷检测；
 * 暂停时不产生新步 → 检测稳定；2x 倍速下步长不变 → 检测密度与 1x 一致。
 *
 * mystery（未知海况）模式：测量记录与面板均不写入/显示理论值与误差；
 * 理论海况仍可经 getTheoreticalSeaState 读取（任务六评分归 tasks 模块）。
 */
import { STORE_EVENTS } from '../core/constants';
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { InstrumentKind, MeasurementRecord, SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';
import {
  emptyBuoyStats,
  computeBuoyStats,
  type BuoyEtaSample,
  type BuoyStats,
} from './buoyStats';
import { buoyPositionAt, mainWaveFromComponents, type MainWaveInfo } from './buoyKinematics';
import { createBeatMeter } from './beatMeter';
import { formatPercentValue, formatValue, makeRecordId, percentError } from './common';
import { instrumentLabel, paramsSnapshotNote } from './measurements';
import { createMeasurementsView } from './measurementsView';
import { injectModuleStyleOnce, removeModuleStyle } from './moduleStyle';
// （moduleStyle 为 instruments 本地副本，不引用 src/viz —— 跨 feature 零 import）
import {
  createStreamExtremaDetector,
  type ExtremumSample,
  type StreamExtremaDetector,
} from './peakDetector';
import { createLocalRingBuffer, type LocalRingBuffer } from './ringBuffer';
import { createStopwatchLogic, type StopwatchLogic } from './stopwatch';
import { createWaveRulerLogic, type WaveRulerLogic } from './waveRuler';

/** 仿真固定步 60Hz → 采样 20Hz 的步进（与图表采样率一致） */
const SAMPLE_STRIDE = 3;
const SAMPLE_RATE_HZ = 20;
/** 浮标 η 缓冲：64s × 20Hz（≥512 点要求；同时满足 FFT 1024 点输入） */
const BUOY_BUFFER_CAPACITY = 1280;
/** 浮标轨迹拖尾点数（30s @ 20Hz） */
const BUOY_TRAIL_CAPACITY = 600;
/** 读数 DOM 刷新节流：每 6 步（10Hz） */
const UI_REFRESH_STRIDE = 6;
/** 浮标统计重算节流：每 30 步（0.5s） */
const STATS_STRIDE = 30;

const STYLE_ID = 'inst-instruments-styles';

const STYLE_CSS = `
.inst-panel{display:flex;flex-direction:column;gap:8px;color:#9DC3BC;font-size:12px}
.inst-switch{display:flex;gap:6px}
.inst-switch button{flex:1;padding:6px 4px;border:1px solid rgba(127,212,193,.18);border-radius:6px;background:rgba(4,31,34,.5);color:#9DC3BC;font-size:12px;cursor:pointer}
.inst-switch button.is-active{border-color:rgba(127,212,193,.65);color:#E8F5F1;background:rgba(127,212,193,.12)}
.inst-section{border:1px solid rgba(127,212,193,.18);border-radius:8px;background:rgba(6,42,46,.85);padding:8px 10px;display:none;flex-direction:column;gap:6px}
.inst-section.is-active{display:flex}
.inst-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.inst-label{color:#9DC3BC;font-size:11px}
.inst-input{width:64px;padding:3px 6px;border:1px solid rgba(127,212,193,.25);border-radius:4px;background:rgba(4,31,34,.6);color:#E8F5F1;font-family:Consolas,monospace;font-size:11px}
.inst-select{padding:3px 4px;border:1px solid rgba(127,212,193,.25);border-radius:4px;background:rgba(4,31,34,.6);color:#E8F5F1;font-family:Consolas,monospace;font-size:11px}
.inst-btn{padding:5px 10px;border:1px solid rgba(127,212,193,.4);border-radius:6px;background:rgba(127,212,193,.08);color:#E8F5F1;font-size:11px;cursor:pointer}
.inst-btn:disabled{opacity:.4;cursor:default}
.inst-btn.is-armed{border-color:rgba(242,182,98,.7);color:#F2B662}
.inst-readout{font-family:Consolas,monospace;font-size:11px;color:#E8F5F1;line-height:1.7}
.inst-readout .amber{color:#F2B662}
.inst-state{font-size:11px;color:#9DC3BC;line-height:1.6}
.inst-state.is-done{color:#F2B662}
.inst-note{font-size:10px;color:#9DC3BC;opacity:.8;line-height:1.5}
`;

export interface InstrumentsRuntimeDeps {
  root: HTMLElement;
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
}

// ---------- 浮标遥测（供渲染层 3D 显示浮标与拖尾；运行期不反向依赖） ----------

export interface BuoyTrailPoint {
  x: number;
  y: number;
  eta: number;
  t: number;
}

export interface BuoyTelemetry {
  /** 浮标是否已投放且未回收 */
  isActive(): boolean;
  /** 当前水平位置（m）；未投放为 null */
  position(): { x: number; y: number } | null;
  /** 轨迹拖尾（时间升序，最近 600 点） */
  trail(): readonly BuoyTrailPoint[];
  /** 最近一次统计（0.5s 刷新一次） */
  latestStats(): BuoyStats | null;
}

export type InstrumentsWithTelemetry = {
  mount(): void;
  record(values: Record<string, number>, note?: string): void;
  setActive(kind: InstrumentKind | null): void;
  getTheoreticalSeaState(): { hs: number; tp: number; wavelength: number };
  dispose(): void;
  buoyTelemetry(): BuoyTelemetry;
};

interface BuoyRuntime {
  p0: { x: number; y: number };
  t0: number;
  wave: MainWaveInfo | null;
  buffer: LocalRingBuffer<BuoyEtaSample>;
  trail: LocalRingBuffer<BuoyTrailPoint>;
  stats: BuoyStats;
  lastEta: number;
}

export function createInstrumentsRuntime(deps: InstrumentsRuntimeDeps): InstrumentsWithTelemetry {
  const { root, store, waveField, clock } = deps;

  let mounted = false;
  let stepCount = 0;
  let lastStepT = Number.NaN; // 上一步仿真时间（时钟回退检测用）
  const unsubscribes: Array<() => void> = [];

  // ---- 仪器逻辑 ----
  const peakDetector: StreamExtremaDetector = createStreamExtremaDetector('peak');
  const troughDetector: StreamExtremaDetector = createStreamExtremaDetector('trough');
  const ruler: WaveRulerLogic = createWaveRulerLogic();
  const stopwatch: StopwatchLogic = createStopwatchLogic();
  // 拍周期估计：计时会话期间逐峰追踪包络极大（judges 读秒表记录的 beatingPeriod 键）
  const beatMeter = createBeatMeter();
  let buoy: BuoyRuntime | null = null;

  // 探针处最近极值缓存（波高尺拾取用）
  let lastPeak: ExtremumSample | null = null;
  let lastTrough: ExtremumSample | null = null;
  let probeEta = 0;

  // ---- DOM 引用 ----
  const sections = new Map<InstrumentKind, HTMLElement>();
  let switchButtons = new Map<InstrumentKind, HTMLButtonElement>();
  // 波高尺
  let rulerStateEl: HTMLElement | null = null;
  let rulerEtaEl: HTMLElement | null = null;
  let probeXInput: HTMLInputElement | null = null;
  let probeYInput: HTMLInputElement | null = null;
  // 秒表
  let stopwatchStateEl: HTMLElement | null = null;
  let stopwatchCountEl: HTMLElement | null = null;
  let stopwatchTargetSel: HTMLSelectElement | null = null;
  // 浮标
  let buoyStateEl: HTMLElement | null = null;
  let buoyStatsEl: HTMLElement | null = null;
  let buoyDeployBtn: HTMLButtonElement | null = null;
  let buoyRecordBtn: HTMLButtonElement | null = null;
  let buoyRecycleBtn: HTMLButtonElement | null = null;
  let measurementsView: ReturnType<typeof createMeasurementsView> | null = null;

  // ---------- 小工具 ----------

  function el(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const btn = el('button', 'inst-btn', label) as HTMLButtonElement;
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function isMystery(): boolean {
    const state = store.getState();
    return state.experiment === 'spectrum' && state.params.spectrum.mystery;
  }

  /** 记录一次测量：追加 MeasurementRecord + emit(MEASUREMENT_ADDED)（写入权归本模块） */
  function commitRecord(
    tool: InstrumentKind,
    values: Record<string, number>,
    extraNote?: string,
  ): void {
    const state = store.getState();
    const note = [paramsSnapshotNote(state.experiment, state.params), extraNote]
      .filter((s): s is string => Boolean(s))
      .join(' · ');
    const record: MeasurementRecord = {
      id: makeRecordId(),
      tool,
      simTime: clock.time(),
      values,
      note,
    };
    store.setState((s) => ({ measurements: [...s.measurements, record] }));
    store.emit(STORE_EVENTS.MEASUREMENT_ADDED, record);
  }

  function getTheory() {
    return waveField.observedSeaState();
  }

  // ---------- 各仪器动作 ----------

  function applyProbeInputs(): void {
    if (!probeXInput || !probeYInput) return;
    const x = Number(probeXInput.value);
    const y = Number(probeYInput.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    store.setState({ probe: { x, y } });
  }

  function rulerPickPeak(): void {
    if (!ruler.pickPeak(lastPeak)) {
      updateRulerPanel('尚未检测到波峰——等待波形经过探针。');
    }
    updateRulerPanel();
  }

  function rulerPickTrough(): void {
    if (!ruler.state.peak) {
      updateRulerPanel('请先拾取波峰。');
      return;
    }
    const result = ruler.pickTrough(lastTrough);
    if (result === 'completed') {
      const { waveHeight, peak: p, trough: tr } = ruler.state;
      const hs = getTheory().hs;
      const mystery = isMystery();
      const values: Record<string, number> = {
        eta: p ? p.eta : 0,
        troughEta: tr ? tr.eta : 0,
        waveHeight: waveHeight ?? 0,
      };
      if (!mystery && hs > 1e-9) {
        const err = percentError(waveHeight ?? 0, hs);
        values.theoreticalHs = hs;
        if (err !== null) values.errorPct = err;
      }
      commitRecord('wave-ruler', values, `测量点 (x=${store.getState().probe.x.toFixed(1)}, y=${store.getState().probe.y.toFixed(1)}) m`);
    }
    updateRulerPanel();
  }

  function stopwatchStart(): void {
    const target = Number(stopwatchTargetSel?.value ?? 3);
    stopwatch.start(Number.isFinite(target) ? target : 3);
    beatMeter.reset(); // 新计时会话：拍包络重新追踪
    updateStopwatchPanel('计时中——等待波峰经过探针…');
  }

  function stopwatchStop(): void {
    const reading = stopwatch.stopManual();
    if (reading && reading.usedPeaks >= 2) {
      commitStopwatchRecord(reading.periodSeconds, reading.usedPeaks);
      updateStopwatchPanel();
    } else {
      stopwatch.reset();
      beatMeter.reset();
      updateStopwatchPanel('有效波峰不足 2 个，未形成周期读数。');
    }
  }

  function commitStopwatchRecord(period: number, usedPeaks: number): void {
    const tp = getTheory().tp;
    const values: Record<string, number> = { peakCount: usedPeaks, period };
    // 拍周期：计时会话内包络显著极大间隔 ≥2 次才有估计；无估计不写键（不伪造读数）
    const beat = beatMeter.periodSeconds();
    if (beat !== null) values.beatingPeriod = beat;
    beatMeter.reset(); // 读数已落账，会话内包络追踪清空
    if (!isMystery() && tp > 1e-9) {
      const err = percentError(period, tp);
      values.theoreticalTp = tp;
      if (err !== null) values.errorPct = err;
    }
    commitRecord('stopwatch', values);
  }

  function deployBuoy(): void {
    const probe = store.getState().probe;
    buoy = {
      p0: { x: probe.x, y: probe.y },
      t0: clock.time(),
      wave: mainWaveFromComponents(waveField.components()),
      buffer: createLocalRingBuffer<BuoyEtaSample>(BUOY_BUFFER_CAPACITY),
      trail: createLocalRingBuffer<BuoyTrailPoint>(BUOY_TRAIL_CAPACITY),
      stats: emptyBuoyStats(),
      lastEta: 0,
    };
    updateBuoyPanel();
  }

  function recycleBuoy(): void {
    buoy = null;
    updateBuoyPanel();
  }

  function recordBuoyReading(): void {
    if (!buoy) {
      updateBuoyPanel('请先投放浮标。');
      return;
    }
    const stats = computeBuoyStats(buoy.buffer.toArray(), SAMPLE_RATE_HZ);
    const mystery = isMystery();
    const sea = getTheory();
    const values: Record<string, number> = {
      eta: buoy.lastEta,
      hsEstimate: stats.hs4Sigma,
      h13: stats.h13 ?? 0,
      zeroCrossPeriod: stats.zeroUpCrossPeriod ?? 0,
      spectralPeakPeriod: stats.spectralPeakPeriod ?? 0,
    };
    if (!mystery) {
      if (sea.hs > 1e-9) {
        const hsErr = percentError(stats.hs4Sigma, sea.hs);
        values.theoreticalHs = sea.hs;
        if (hsErr !== null) values.hsErrorPct = hsErr;
      }
      if (sea.tp > 1e-9 && stats.spectralPeakPeriod !== null) {
        const tpErr = percentError(stats.spectralPeakPeriod, sea.tp);
        values.theoreticalTp = sea.tp;
        if (tpErr !== null) values.tpErrorPct = tpErr;
      }
    }
    const drift = buoy.wave
      ? Math.hypot(
          buoyPositionAt(buoy.p0, buoy.t0, clock.time(), buoy.wave).x - buoy.p0.x,
          buoyPositionAt(buoy.p0, buoy.t0, clock.time(), buoy.wave).y - buoy.p0.y,
        )
      : 0;
    commitRecord(
      'drifter-buoy',
      values,
      `漂移距离 ${drift.toFixed(1)}m 样本 ${stats.sampleCount}`,
    );
  }

  // ---------- 面板刷新 ----------

  function updateRulerPanel(message?: string): void {
    if (!rulerStateEl) return;
    const st = ruler.state;
    if (st.phase === 'complete' && st.waveHeight !== null) {
      const hs = getTheory().hs;
      const err = !isMystery() && hs > 1e-9 ? percentError(st.waveHeight, hs) : null;
      rulerStateEl.innerHTML =
        `波峰 η=${formatValue(st.peak?.eta)}m（t=${formatValue(st.peak?.t, 1)}s）<br>` +
        `波谷 η=${formatValue(st.trough?.eta)}m（t=${formatValue(st.trough?.t, 1)}s）<br>` +
        `<span class="amber">波高 H = ${formatValue(st.waveHeight)}m</span><br>` +
        (err !== null
          ? `理论 Hs = ${formatValue(hs)}m · 误差 <span class="amber">${formatPercentValue(err)}</span>`
          : '理论值不可比（静水或未知海况）') +
        `<br><span class="inst-note">已写入测量记录。继续测量请重置。</span>`;
      rulerStateEl.classList.add('is-done');
    } else if (st.phase === 'awaiting-trough') {
      rulerStateEl.innerHTML = `已锁定波峰 η=${formatValue(st.peak?.eta)}m——等待相邻波谷经过，或再次点击拾取波谷。`;
      rulerStateEl.classList.remove('is-done');
    } else {
      rulerStateEl.innerHTML = '依次点击「拾取波峰」「拾取波谷」测得一个波高。';
      rulerStateEl.classList.remove('is-done');
    }
    if (message) {
      rulerStateEl.innerHTML += `<br><span class="inst-note">${message}</span>`;
    }
  }

  function updateStopwatchPanel(message?: string): void {
    if (!stopwatchStateEl || !stopwatchCountEl) return;
    const reading = stopwatch.reading;
    stopwatchCountEl.textContent = `已捕获 ${stopwatch.capturedCount} / ${stopwatch.targetPeaks} 个波峰`;
    stopwatchStateEl.classList.remove('is-done');
    if (reading) {
      const tp = getTheory().tp;
      const err = !isMystery() && tp > 1e-9 ? percentError(reading.periodSeconds, tp) : null;
      stopwatchStateEl.innerHTML =
        `<span class="amber">周期 T = ${formatValue(reading.periodSeconds)}s</span><br>` +
        (err !== null
          ? `理论 Tp = ${formatValue(tp)}s · 误差 <span class="amber">${formatPercentValue(err)}</span>`
          : '理论值不可比（静水或未知海况）') +
        `<br><span class="inst-note">${reading.usedPeaks} 个波峰 / ${reading.usedPeaks - 1} 个周期，已写入测量记录。</span>`;
      stopwatchStateEl.classList.add('is-done');
    } else if (stopwatch.phase === 'running') {
      stopwatchStateEl.textContent = '计时中……';
    } else if (message) {
      stopwatchStateEl.textContent = message;
    } else {
      stopwatchStateEl.textContent = '点「开始」后自动统计波峰间隔，集满自动停止。';
    }
    if (message && reading) {
      stopwatchStateEl.innerHTML += `<br><span class="inst-note">${message}</span>`;
    }
  }

  function updateBuoyPanel(message?: string): void {
    if (!buoyStateEl || !buoyStatsEl) return;
    const spectral = store.getState().experiment === 'spectrum';
    if (!buoy) {
      buoyStateEl.innerHTML = '未投放。浮标将在探针位置下水，以主波相速度随浪漂移。';
      buoyStatsEl.textContent = '';
      if (buoyDeployBtn) buoyDeployBtn.disabled = false;
      if (buoyRecordBtn) buoyRecordBtn.disabled = true;
      if (buoyRecycleBtn) buoyRecycleBtn.disabled = true;
    } else {
      const t = clock.time();
      const pos = buoy.wave ? buoyPositionAt(buoy.p0, buoy.t0, t, buoy.wave) : buoy.p0;
      const drift = buoy.wave
        ? Math.hypot(pos.x - buoy.p0.x, pos.y - buoy.p0.y)
        : 0;
      buoyStateEl.innerHTML =
        `位置 (x=${pos.x.toFixed(1)}, y=${pos.y.toFixed(1)})m · 漂移 ${drift.toFixed(1)}m<br>` +
        `当前 η = ${buoy.lastEta >= 0 ? '+' : ''}${buoy.lastEta.toFixed(3)}m · 拖尾 ${buoy.trail.length} 点`;
      if (buoyDeployBtn) buoyDeployBtn.disabled = true;
      if (buoyRecordBtn) buoyRecordBtn.disabled = false;
      if (buoyRecycleBtn) buoyRecycleBtn.disabled = false;

      if (spectral && buoy.stats.sampleCount > 0) {
        const s = buoy.stats;
        const sea = getTheory();
        const hidden = isMystery();
        buoyStatsEl.innerHTML =
          `<span class="amber">海洋观测浮标统计</span><br>` +
          `Hs 估计（4σ）= ${formatValue(s.hs4Sigma)}m · H1/3 = ${formatValue(s.h13)}m<br>` +
          `平均过零周期 Tz = ${formatValue(s.zeroUpCrossPeriod)}s · 谱峰估计 T̂p = ${formatValue(s.spectralPeakPeriod)}s` +
          (hidden
            ? '<br><span class="inst-note">未知海况模式：理论值已隐藏。</span>'
            : `<br>理论 Hs = ${formatValue(sea.hs)}m（误差 ${formatPercentValue(percentError(s.hs4Sigma, sea.hs))}）· 理论 Tp = ${formatValue(sea.tp)}s（误差 ${formatPercentValue(s.spectralPeakPeriod !== null ? percentError(s.spectralPeakPeriod, sea.tp) : null)}）`) +
          `<br><span class="inst-note">样本 ${s.sampleCount} · 波数 ${s.waveCount} · 采样 ${SAMPLE_RATE_HZ}Hz</span>`;
      } else if (spectral) {
        buoyStatsEl.textContent = '观测统计累计中（需要约 3 秒样本）……';
      } else {
        buoyStatsEl.textContent = '';
      }
    }
    if (message) buoyStateEl.innerHTML += `<br><span class="inst-note">${message}</span>`;
  }

  function syncActiveUI(): void {
    const active = store.getState().activeInstrument;
    for (const [kind, btn] of switchButtons) {
      btn.classList.toggle('is-active', kind === active);
    }
    for (const [kind, section] of sections) {
      section.classList.toggle('is-active', kind === active);
    }
  }

  // ---------- 每固定仿真步 ----------

  function onSimulationStep(): void {
    stepCount += 1;
    const state = store.getState();
    const t = clock.time();

    // 时钟回退（实验重置）：检测器/波高尺/秒表/浮标都锚定旧仿真时间——
    // 检测器断档保护只处理时间前进，秒表单调防护理会倒退时刻（永久卡死），
    // 浮标 p = p0 + cp·(t − t0) 会瞬移到 −cp·t0。回退即整体复位重新积累。
    if (Number.isFinite(lastStepT) && t < lastStepT - 0.5) {
      peakDetector.reset();
      troughDetector.reset();
      lastPeak = null;
      lastTrough = null;
      ruler.reset();
      stopwatch.reset();
      beatMeter.reset();
      buoy = null;
      updateRulerPanel('仿真时间已重置，测量状态已复位。');
      updateStopwatchPanel('仿真时间已重置，请重新开始计时。');
      updateBuoyPanel('仿真时间已重置，浮标已回收，请重新投放。');
    }
    lastStepT = t;

    // 1) 探针采样（60Hz，供峰/谷检测）
    const sample = waveField.evalSurface(state.probe.x, state.probe.y, t);
    probeEta = sample.eta;
    const fedPeak = peakDetector.feed({ t, eta: sample.eta });
    const fedTrough = troughDetector.feed({ t, eta: sample.eta });
    if (fedPeak) lastPeak = fedPeak;
    if (fedTrough) lastTrough = fedTrough;

    // 2) 秒表计数
    if (stopwatch.phase === 'running' && fedPeak) {
      beatMeter.feed(fedPeak); // 逐峰喂入拍包络追踪（峰高序列即包络采样）
      const { count, finished } = stopwatch.onPeak(fedPeak.t);
      if (!finished && stopwatchCountEl) {
        stopwatchCountEl.textContent = `已捕获 ${count} / ${stopwatch.targetPeaks} 个波峰`;
      }
      if (finished && stopwatch.reading) {
        commitStopwatchRecord(stopwatch.reading.periodSeconds, stopwatch.reading.usedPeaks);
        updateStopwatchPanel();
      }
    }

    // 3) 波高尺等待中的谷
    if (ruler.state.phase === 'awaiting-trough' && fedTrough) {
      if (ruler.feedTrough(fedTrough)) {
        rulerPickTroughFromFeed();
      }
    }

    // 4) 浮标推进（20Hz 采样，与 FFT 假设一致）
    if (buoy) {
      if (stepCount % SAMPLE_STRIDE === 0) {
        const pos = buoy.wave ? buoyPositionAt(buoy.p0, buoy.t0, t, buoy.wave) : buoy.p0;
        const s = waveField.evalSurface(pos.x, pos.y, t);
        buoy.lastEta = s.eta;
        buoy.buffer.push({ t, eta: s.eta });
        buoy.trail.push({ x: pos.x, y: pos.y, eta: s.eta, t });
      }
      if (stepCount % STATS_STRIDE === 0) {
        buoy.stats = computeBuoyStats(buoy.buffer.toArray(), SAMPLE_RATE_HZ);
      }
    }

    // 5) 读数 UI 节流刷新（10Hz）
    if (stepCount % UI_REFRESH_STRIDE === 0) {
      if (rulerEtaEl) {
        rulerEtaEl.textContent = `探针当前 η = ${probeEta >= 0 ? '+' : ''}${probeEta.toFixed(3)} m`;
      }
      if (state.activeInstrument === 'drifter-buoy') updateBuoyPanel();
    }
  }

  /** feedTrough 完成测量后与手动拾取共用同一条落账路径 */
  function rulerPickTroughFromFeed(): void {
    const st = ruler.state;
    if (st.phase !== 'complete' || st.waveHeight === null) return;
    const hs = getTheory().hs;
    const mystery = isMystery();
    const values: Record<string, number> = {
      eta: st.peak ? st.peak.eta : 0,
      troughEta: st.trough ? st.trough.eta : 0,
      waveHeight: st.waveHeight,
    };
    if (!mystery && hs > 1e-9) {
      const err = percentError(st.waveHeight, hs);
      values.theoreticalHs = hs;
      if (err !== null) values.errorPct = err;
    }
    commitRecord('wave-ruler', values, '自动拾取相邻波谷');
    updateRulerPanel();
  }

  // ---------- 组装面板 ----------

  function buildPanel(): void {
    root.classList.add('inst-panel');
    root.innerHTML = '';

    const switchRow = el('div', 'inst-switch');
    const kinds: InstrumentKind[] = ['wave-ruler', 'stopwatch', 'drifter-buoy'];
    for (const kind of kinds) {
      const btn = button(instrumentLabel(kind), () => {
        setActive(kind === store.getState().activeInstrument ? null : kind);
      });
      switchButtons.set(kind, btn);
      switchRow.appendChild(btn);
    }
    root.appendChild(switchRow);

    // ---- 波高尺 ----
    const rulerSection = el('section', 'inst-section');
    sections.set('wave-ruler', rulerSection);
    rulerEtaEl = el('div', 'inst-readout', '探针当前 η = —');
    rulerSection.appendChild(rulerEtaEl);

    const probeRow = el('div', 'inst-row');
    probeRow.appendChild(el('span', 'inst-label', '测量点 x'));
    probeXInput = el('input', 'inst-input') as HTMLInputElement;
    probeXInput.type = 'number';
    probeXInput.step = '0.5';
    probeXInput.value = String(store.getState().probe.x);
    probeRow.appendChild(probeXInput);
    probeRow.appendChild(el('span', 'inst-label', 'y'));
    probeYInput = el('input', 'inst-input') as HTMLInputElement;
    probeYInput.type = 'number';
    probeYInput.step = '0.5';
    probeYInput.value = String(store.getState().probe.y);
    probeRow.appendChild(probeYInput);
    probeRow.appendChild(
      button('设定探针', applyProbeInputs),
    );
    rulerSection.appendChild(probeRow);

    const rulerActions = el('div', 'inst-row');
    rulerActions.appendChild(button('拾取波峰', rulerPickPeak));
    rulerActions.appendChild(button('拾取波谷', rulerPickTrough));
    rulerActions.appendChild(button('重置', () => { ruler.reset(); updateRulerPanel(); }));
    rulerSection.appendChild(rulerActions);

    rulerStateEl = el('div', 'inst-state');
    rulerSection.appendChild(rulerStateEl);
    rulerSection.appendChild(
      el(
        'div',
        'inst-note',
        '波峰/波谷由探针处真实波面检测得出；测量值与理论 Hs 对比写入测量记录。',
      ),
    );
    root.appendChild(rulerSection);

    // ---- 秒表 ----
    const swSection = el('section', 'inst-section');
    sections.set('stopwatch', swSection);
    const swRow = el('div', 'inst-row');
    swRow.appendChild(el('span', 'inst-label', '目标波峰数'));
    stopwatchTargetSel = el('select', 'inst-select') as HTMLSelectElement;
    for (let n = 2; n <= 8; n++) {
      const opt = el('option') as HTMLOptionElement;
      opt.value = String(n);
      opt.textContent = String(n);
      stopwatchTargetSel.appendChild(opt);
    }
    stopwatchTargetSel.value = '3';
    swRow.appendChild(stopwatchTargetSel);
    swSection.appendChild(swRow);

    const swActions = el('div', 'inst-row');
    swActions.appendChild(button('开始', stopwatchStart));
    swActions.appendChild(button('停止', stopwatchStop));
    swActions.appendChild(button('重置', () => { stopwatch.reset(); updateStopwatchPanel(); }));
    swSection.appendChild(swActions);

    stopwatchCountEl = el('div', 'inst-readout', '已捕获 0 / 3 个波峰');
    swSection.appendChild(stopwatchCountEl);
    stopwatchStateEl = el('div', 'inst-state');
    swSection.appendChild(stopwatchStateEl);
    swSection.appendChild(
      el(
        'div',
        'inst-note',
        '周期 = 首末波峰时间差 ÷（波峰数 − 1）；与理论 Tp 对比写入测量记录。',
      ),
    );
    root.appendChild(swSection);

    // ---- 观测浮标 ----
    const buoySection = el('section', 'inst-section');
    sections.set('drifter-buoy', buoySection);
    const buoyActions = el('div', 'inst-row');
    buoyDeployBtn = button('在探针处投放', deployBuoy);
    buoyRecordBtn = button('记录读数', recordBuoyReading);
    buoyRecycleBtn = button('回收', recycleBuoy);
    buoyRecordBtn.disabled = true;
    buoyRecycleBtn.disabled = true;
    buoyActions.appendChild(buoyDeployBtn);
    buoyActions.appendChild(buoyRecordBtn);
    buoyActions.appendChild(buoyRecycleBtn);
    buoySection.appendChild(buoyActions);

    buoyStateEl = el('div', 'inst-readout');
    buoySection.appendChild(buoyStateEl);
    buoyStatsEl = el('div', 'inst-state');
    buoySection.appendChild(buoyStatsEl);
    buoySection.appendChild(
      el(
        'div',
        'inst-note',
        '浮标以主波相速度随浪漂移并记录自身起伏；实验三下升级为海洋观测浮标，给出 Hs / Tp 实测估计。',
      ),
    );
    root.appendChild(buoySection);

    // ---- 测量记录（『数据』内容，同面板内嵌；亦可由集成单独挂载） ----
    const measureSection = el('section', 'inst-section is-active');
    const measureSlot = el('div');
    measureSection.appendChild(measureSlot);
    root.appendChild(measureSection);
    measurementsView = createMeasurementsView({ root: measureSlot, store });
    measurementsView.mount();
  }

  // ---------- 契约方法 ----------

  function setActive(kind: InstrumentKind | null): void {
    store.setState({ activeInstrument: kind });
    store.emit(STORE_EVENTS.INSTRUMENT_CHANGED, kind);
    syncActiveUI();
  }

  return {
    mount(): void {
      if (mounted) return;
      mounted = true;
      injectModuleStyleOnce(STYLE_ID, STYLE_CSS);
      buildPanel();
      syncActiveUI();
      updateRulerPanel();
      updateStopwatchPanel();
      updateBuoyPanel();

      unsubscribes.push(clock.onStep(onSimulationStep));
      unsubscribes.push(
        store.subscribe((state, prev) => {
          if (state.activeInstrument !== prev.activeInstrument) syncActiveUI();
          // 探针被外部移动：重置检测器与波高尺待定状态（秒表不打断）
          if (state.probe !== prev.probe) {
            peakDetector.reset();
            troughDetector.reset();
            if (ruler.state.phase === 'awaiting-trough') ruler.reset();
            updateRulerPanel('探针已移动，检测器已复位。');
          }
          if (state.experiment !== prev.experiment) {
            // 切实验：主波方向/相速度变化，浮标按新海况重定相速度
            if (buoy) buoy.wave = mainWaveFromComponents(waveField.components());
            updateBuoyPanel();
          }
        }),
      );
    },

    record(values: Record<string, number>, note?: string): void {
      commitRecord(store.getState().activeInstrument ?? 'wave-ruler', values, note);
    },

    setActive,

    getTheoreticalSeaState() {
      const sea = waveField.observedSeaState();
      return { hs: sea.hs, tp: sea.tp, wavelength: sea.wavelength };
    },

    dispose(): void {
      for (const off of unsubscribes.splice(0)) off();
      measurementsView?.dispose();
      measurementsView = null;
      sections.clear();
      switchButtons = new Map();
      buoy = null;
      root.innerHTML = '';
      removeModuleStyle(STYLE_ID);
      mounted = false;
    },

    buoyTelemetry(): BuoyTelemetry {
      return {
        isActive: () => buoy !== null,
        position: () => {
          if (!buoy) return null;
          const t = clock.time();
          return buoy.wave ? buoyPositionAt(buoy.p0, buoy.t0, t, buoy.wave) : { ...buoy.p0 };
        },
        trail: () => (buoy ? buoy.trail.toArray() : []),
        latestStats: () => (buoy ? buoy.stats : null),
      };
    },
  };
}
