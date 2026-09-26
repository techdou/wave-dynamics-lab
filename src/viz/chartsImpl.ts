/**
 * createCharts 实现主体 —— src/charts/charts.ts 契约的运行时（SPEC §7.3）。
 * 数据流：clock.onStep 固定仿真步（60Hz）→ 每 SAMPLE_STRIDE 步在 store.probe 处
 * evalSurface 采样一次（≈20Hz）→ 环形缓冲 → Canvas 重绘。
 * 理论谱 / stem / fp 每次 tick 从 waveField 现算，谱型与参数变化即时反映；
 * PARAMS_CHANGED / EXPERIMENT_CHANGED 时额外立即重绘（暂停态下也刷新）。
 * 不自起 rAF（SPEC §7 铁律 5）。
 */
import { STORE_EVENTS } from '../core/constants';
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';
import { componentEnergyStems } from './componentSpectrum';
import { injectModuleStyleOnce, removeModuleStyle } from './moduleStyle';
import { createRingBuffer, type RingBuffer } from './ringBuffer';
import { scanExtrema, type TimeValueSample } from './sampleScan';
import { createSpectrumChart, type SpectrumChart } from './spectrumChart';
import { createTimeSeriesChart, type TimeSeriesChart } from './timeSeriesChart';

/** 仿真固定步 60Hz → 采样 20Hz 的步进 */
const SAMPLE_STRIDE = 3;
const SAMPLE_RATE_HZ = 20;
/** 理论谱曲线采样点数（对数分布） */
const THEORY_POINTS = 140;
const THEORY_F_MIN = 0.02;
const THEORY_F_MAX = 2;
const STYLE_ID = 'viz-charts-styles';

const STYLE_CSS = `
.viz-charts{display:flex;flex-direction:column;gap:10px;color:#9DC3BC;font-size:12px}
.viz-block{border:1px solid rgba(127,212,193,.18);background:rgba(6,42,46,.85);border-radius:8px;padding:8px 10px 6px}
.viz-block-title{color:#E8F5F1;font-size:12px;letter-spacing:.5px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:baseline}
.viz-block-title small{color:#9DC3BC;font-size:10px;font-family:Consolas,monospace}
.viz-dispersion{display:none;margin-top:6px;padding:6px 8px;border:1px dashed rgba(242,182,98,.45);border-radius:6px;color:#F2B662;font-size:11px;line-height:1.6}
.viz-dispersion.is-visible{display:block}
.viz-probe-row{margin-top:4px;color:#9DC3BC;font-size:10px;font-family:Consolas,monospace}
`;

export interface ChartsRuntimeDeps {
  root: HTMLElement;
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
  timeWindowSeconds?: number;
}

export interface Charts {
  mount(): void;
  update(): void;
  dispose(): void;
}

export function createChartsRuntime(deps: ChartsRuntimeDeps): Charts {
  const { root, store, waveField, clock } = deps;
  const windowSeconds = deps.timeWindowSeconds ?? 60;
  const buffer: RingBuffer<TimeValueSample> = createRingBuffer(
    Math.ceil(windowSeconds * SAMPLE_RATE_HZ) + 8,
  );

  let mounted = false;
  let etaChart: TimeSeriesChart | null = null;
  let spectrumChart: SpectrumChart | null = null;
  let spectrumSection: HTMLElement | null = null;
  let dispersionNote: HTMLElement | null = null;
  let probeRow: HTMLElement | null = null;
  let stepCount = 0;
  let lastSampleT = Number.NaN; // 上一步仿真时间（时钟回退检测用）
  const unsubscribes: Array<() => void> = [];

  // ---------- 谱数据现算 ----------

  function sampleTheoryCurve(): { f: number; s: number }[] {
    const points: { f: number; s: number }[] = [];
    const logMin = Math.log10(THEORY_F_MIN);
    const logMax = Math.log10(THEORY_F_MAX);
    for (let i = 0; i < THEORY_POINTS; i++) {
      const f = Math.pow(10, logMin + ((logMax - logMin) * i) / (THEORY_POINTS - 1));
      const s = waveField.spectrum(f);
      if (Number.isFinite(s) && s > 0) points.push({ f, s });
    }
    return points;
  }

  function currentPeakInfo(): { peakFrequency: number | null; peakPeriod: number | null } {
    const sea = waveField.observedSeaState();
    return {
      peakFrequency: sea.peakFrequency > 0 ? sea.peakFrequency : null,
      peakPeriod: sea.tp > 0 ? sea.tp : null,
    };
  }

  function drawSpectrum(): void {
    if (!spectrumChart) return;
    spectrumChart.draw({
      theory: sampleTheoryCurve(),
      stems: componentEnergyStems(waveField.components()).map((p) => ({
        f: p.f,
        s: p.energyDensity,
      })),
      ...currentPeakInfo(),
    });
  }

  function drawEta(): void {
    if (!etaChart) return;
    const samples = buffer.toArray();
    etaChart.setViewTime(clock.time());
    etaChart.draw(
      samples,
      scanExtrema(samples, 'peak'),
      scanExtrema(samples, 'trough'),
    );
  }

  function refreshExperimentLayout(): void {
    if (!spectrumSection || !dispersionNote) return;
    const spectral = store.getState().experiment === 'spectrum';
    spectrumSection.style.display = spectral ? '' : 'none';
    dispersionNote.classList.toggle('is-visible', !spectral);
  }

  // ---------- 每固定仿真步回调（charts 刷新唯一驱动） ----------

  function onSimulationStep(): void {
    stepCount += 1;
    const state = store.getState();
    const t = clock.time();
    // 时钟回退（实验重置）：缓冲里是旧时间基样本，与新 t≈0 样本混存会把
    // η(t) 曲线画出横贯画布的连线伪影——检测到回退即清空重新积累。
    if (Number.isFinite(lastSampleT) && t < lastSampleT - 0.5) buffer.clear();
    lastSampleT = t;
    const sample = waveField.evalSurface(state.probe.x, state.probe.y, t);
    if (stepCount % SAMPLE_STRIDE === 0) {
      buffer.push({ t, v: sample.eta });
      drawEta();
      // 谱图与采样同频（20Hz）重绘：参数变化最迟 50ms 反映，且留有余量
      drawSpectrum();
    }
    if (stepCount % (SAMPLE_STRIDE * 5) === 0 && probeRow) {
      probeRow.textContent = `探针 (x=${state.probe.x.toFixed(1)}, y=${state.probe.y.toFixed(1)}) m · 采样 ${SAMPLE_RATE_HZ} Hz`;
    }
  }

  // ---------- mount / update / dispose ----------

  return {
    mount(): void {
      if (mounted) return;
      mounted = true;
      injectModuleStyleOnce(STYLE_ID, STYLE_CSS);

      root.classList.add('viz-charts');
      root.innerHTML = '';

      const etaSection = document.createElement('section');
      etaSection.className = 'viz-block';
      const etaTitle = document.createElement('header');
      etaTitle.className = 'viz-block-title';
      etaTitle.innerHTML =
        'η(t) 波面时间序列<small>探针采样 20 Hz</small>';
      etaSection.appendChild(etaTitle);
      const etaWrap = document.createElement('div');
      etaWrap.className = 'viz-canvas-wrap';
      etaSection.appendChild(etaWrap);
      probeRow = document.createElement('div');
      probeRow.className = 'viz-probe-row';
      etaSection.appendChild(probeRow);
      root.appendChild(etaSection);

      const specSection = document.createElement('section');
      specSection.className = 'viz-block';
      const specTitle = document.createElement('header');
      specTitle.className = 'viz-block-title';
      specTitle.innerHTML = 'S(f) 波能谱<small>理论谱 + 分量能量</small>';
      specSection.appendChild(specTitle);
      const specWrap = document.createElement('div');
      specWrap.className = 'viz-canvas-wrap';
      specSection.appendChild(specWrap);
      dispersionNote = document.createElement('div');
      dispersionNote.className = 'viz-dispersion';
      dispersionNote.innerHTML =
        '当前为规则波实验（实验一 / 二），无谱分布，已隐藏谱图。' +
        '深水色散关系：ω² = g·k，相速度 c = √(g/k) = λ/T。' +
        '切换到实验三（随机海况）可查看波能谱。';
      specSection.appendChild(dispersionNote);
      root.appendChild(specSection);

      etaChart = createTimeSeriesChart(etaWrap, { windowSeconds });
      spectrumChart = createSpectrumChart(specWrap);

      refreshExperimentLayout();
      drawEta();
      drawSpectrum();

      unsubscribes.push(clock.onStep(onSimulationStep));
      unsubscribes.push(
        store.subscribe((state, prev) => {
          if (state.experiment !== prev.experiment) {
            refreshExperimentLayout();
            buffer.clear();
          }
          // 参数或探针变化：立即重绘（暂停时也能看到谱型/测量点变化）
          if (
            state.params !== prev.params ||
            state.probe !== prev.probe ||
            state.experiment !== prev.experiment
          ) {
            drawSpectrum();
          }
        }),
      );
      unsubscribes.push(
        store.on(STORE_EVENTS.PARAMS_CHANGED, () => drawSpectrum()),
      );
      unsubscribes.push(
        store.on(STORE_EVENTS.EXPERIMENT_CHANGED, () => {
          refreshExperimentLayout();
          buffer.clear();
        }),
      );
    },

    /** 手动刷新一次（契约保留；常规刷新由 onStep 驱动） */
    update(): void {
      drawEta();
      drawSpectrum();
    },

    dispose(): void {
      for (const off of unsubscribes.splice(0)) off();
      etaChart = null;
      spectrumChart = null;
      spectrumSection = null;
      dispersionNote = null;
      probeRow = null;
      root.innerHTML = '';
      removeModuleStyle(STYLE_ID);
      mounted = false;
    },
  };
}
