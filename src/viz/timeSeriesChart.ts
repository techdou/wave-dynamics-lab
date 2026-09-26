/**
 * η(t) 波面时间序列图 —— Canvas 2D 手写绘制（SPEC §7.3，禁图表库）。
 * 轴 / 网格 / 当前值标注；数据由 chartsImpl 以 20Hz 固定仿真采样喂入，
 * 本文件只负责画，不依赖 store / clock（可在任意容器复用）。
 */
import { formatSigned, niceCeil, niceTimeStep } from './chartMath';
import type { TimeValueSample } from './sampleScan';

/** 深海科研风配色（与 styles/main.css 令牌一致） */
const COLOR = {
  line: '#7FD4C1',
  peak: '#F2B662',
  grid: 'rgba(127, 212, 193, 0.12)',
  axis: 'rgba(127, 212, 193, 0.35)',
  text: '#9DC3BC',
  textStrong: '#E8F5F1',
  zeroLine: 'rgba(232, 245, 241, 0.22)',
} as const;

const FONT = '10px Consolas, "Courier New", monospace';
const PAD = { left: 46, right: 12, top: 10, bottom: 22 } as const;

export interface TimeSeriesChartOptions {
  /** 横轴时间窗口（仿真秒），默认 60 */
  windowSeconds: number;
  /** 画布 CSS 高度（px），默认 150 */
  heightPx?: number;
}

export interface TimeSeriesChart {
  readonly el: HTMLCanvasElement;
  /** 通知当前视图时刻（仿真秒）；决定横轴右端 */
  setViewTime(tNow: number): void;
  /** 全量重绘；samples / peaks / troughs 均按时间升序 */
  draw(
    samples: readonly TimeValueSample[],
    peaks: readonly TimeValueSample[],
    troughs: readonly TimeValueSample[],
  ): void;
  /** 容器尺寸变化后调用（同步 canvas 像素尺寸与 DPR） */
  resize(): void;
}

export function createTimeSeriesChart(
  parent: HTMLElement,
  options: TimeSeriesChartOptions,
): TimeSeriesChart {
  const windowSeconds = Math.max(1, options.windowSeconds);
  const el = document.createElement('canvas');
  el.style.width = '100%';
  el.style.height = `${options.heightPx ?? 150}px`;
  parent.appendChild(el);
  const ctx = el.getContext('2d');

  let viewTime = 0;

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }

  function draw(
    samples: readonly TimeValueSample[],
    peaks: readonly TimeValueSample[],
    troughs: readonly TimeValueSample[],
  ): void {
    if (!ctx || el.clientWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    // 若外部未调 resize，保证像素尺寸与 CSS 尺寸同步（防首帧空白）
    if (el.width !== Math.round(el.clientWidth * dpr)) resize();
    const W = el.clientWidth;
    const H = el.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    if (plotW <= 10 || plotH <= 10) return;

    // 横轴：[tNow − window, max(tNow, window)] —— 未满窗时从 0 起滚
    const t1 = Math.max(viewTime, windowSeconds);
    const t0 = t1 - windowSeconds;

    // 纵轴：对称 [-ymax, ymax]，取窗口内最大 |η| 向上取整刻度（下限 0.1 m）
    let maxAbs = 0.1;
    for (const s of samples) {
      const a = Math.abs(s.v);
      if (a > maxAbs) maxAbs = a;
    }
    const ymax = niceCeil(maxAbs * 1.05);

    const xOf = (t: number): number =>
      PAD.left + ((t - t0) / windowSeconds) * plotW;
    const yOf = (v: number): number =>
      PAD.top + plotH * (1 - (v + ymax) / (2 * ymax));

    // ---- 网格与轴 ----
    ctx.font = FONT;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR.grid;
    ctx.fillStyle = COLOR.text;

    // 横向网格（η 刻度 4 分度）+ 左轴文本
    const yStep = (2 * ymax) / 4;
    for (let i = 0; i <= 4; i++) {
      const v = -ymax + yStep * i;
      const y = yOf(v);
      ctx.globalAlpha = Math.abs(v) < ymax * 1e-9 ? 0 : 1; // 零线单独画
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatSigned(v, 1), PAD.left - 6, y);
    }

    // 纵向网格（时间刻度）+ 底轴文本
    const tStep = niceTimeStep(windowSeconds, 7);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1 + 1e-9; t += tStep) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, H - PAD.bottom);
      ctx.stroke();
      ctx.fillText(`${t.toFixed(0)}`, x, H - PAD.bottom + 5);
    }

    // 零线（静水面）
    ctx.strokeStyle = COLOR.zeroLine;
    ctx.beginPath();
    ctx.moveTo(PAD.left, yOf(0));
    ctx.lineTo(W - PAD.right, yOf(0));
    ctx.stroke();

    // 轴名
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('η/m', 4, PAD.top - 4);
    ctx.textAlign = 'right';
    ctx.fillText('t/s', W - PAD.right, H - PAD.bottom + 5);

    // ---- 曲线 ----
    if (samples.length >= 2) {
      ctx.strokeStyle = COLOR.line;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const s of samples) {
        if (s.t < t0) continue;
        const x = xOf(s.t);
        const y = yOf(s.v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // ---- 峰谷标记 ----
    ctx.fillStyle = COLOR.peak;
    for (const p of peaks) {
      if (p.t < t0) continue;
      ctx.beginPath();
      ctx.arc(xOf(p.t), yOf(p.v), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(90, 200, 232, 0.9)';
    for (const p of troughs) {
      if (p.t < t0) continue;
      ctx.beginPath();
      ctx.arc(xOf(p.t), yOf(p.v), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- 当前值标注（右上角） ----
    const latest = samples.length > 0 ? samples[samples.length - 1] : undefined;
    ctx.fillStyle = COLOR.textStrong;
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const etaText = latest
      ? `η = ${formatSigned(latest.v, 3)} m`
      : 'η = —';
    ctx.fillText(etaText, W - PAD.right, PAD.top);
    if (latest) {
      ctx.fillStyle = COLOR.peak;
      ctx.beginPath();
      ctx.arc(xOf(latest.t), yOf(latest.v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return {
    el,
    setViewTime(t: number): void {
      viewTime = t;
    },
    draw,
    resize,
  };
}
