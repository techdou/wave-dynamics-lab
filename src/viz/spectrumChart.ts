/**
 * S(f) 波能谱图 —— Canvas 2D 手写绘制（SPEC §7.3 / §9.3，禁图表库）。
 * 对数横轴；理论谱曲线 + 实际采样分量能量 stem；标注谱峰频率 fp 与周期 Tp。
 * 数据（理论采样点 / stem 点 / fp）由 chartsImpl 每次重绘时从 waveField 现算喂入。
 */
import { formatFixed, niceCeil } from './chartMath';

const COLOR = {
  theory: '#5AC8E8',
  stem: '#7FD4C1',
  marker: '#F2B662',
  grid: 'rgba(127, 212, 193, 0.12)',
  axis: 'rgba(127, 212, 193, 0.35)',
  text: '#9DC3BC',
  textStrong: '#E8F5F1',
} as const;

const FONT = '10px Consolas, "Courier New", monospace';
const PAD = { left: 50, right: 12, top: 20, bottom: 24 } as const;

/** 分析频带（Hz）：覆盖骨架离散的 0.5fp–4fp 与常见海况 */
const F_MIN = 0.02;
const F_MAX = 2;

export interface SpectrumCurvePoint {
  f: number;
  s: number;
}

export interface SpectrumDrawData {
  /** 理论谱采样点（升序） */
  theory: readonly SpectrumCurvePoint[];
  /** 实际分量离散能量密度点（升序） */
  stems: readonly SpectrumCurvePoint[];
  /** 谱峰频率（Hz）；无谱海况为 null */
  peakFrequency: number | null;
  /** 谱峰周期（s）；无谱海况为 null */
  peakPeriod: number | null;
}

export interface SpectrumChartOptions {
  /** 画布 CSS 高度（px），默认 170 */
  heightPx?: number;
}

export interface SpectrumChart {
  readonly el: HTMLCanvasElement;
  draw(data: SpectrumDrawData): void;
  resize(): void;
}

export function createSpectrumChart(
  parent: HTMLElement,
  options: SpectrumChartOptions = {},
): SpectrumChart {
  const el = document.createElement('canvas');
  el.style.width = '100%';
  el.style.height = `${options.heightPx ?? 170}px`;
  parent.appendChild(el);
  const ctx = el.getContext('2d');

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }

  function draw(data: SpectrumDrawData): void {
    if (!ctx || el.clientWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(el.clientWidth * dpr)) resize();
    const W = el.clientWidth;
    const H = el.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    if (plotW <= 10 || plotH <= 10) return;

    // ---- 值域：取理论曲线与 stem 的并集 ----
    let sMax = 0;
    for (const p of data.theory) if (p.s > sMax) sMax = p.s;
    for (const p of data.stems) if (p.s > sMax) sMax = p.s;
    if (sMax <= 0) {
      ctx.font = FONT;
      ctx.fillStyle = COLOR.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('当前海况无谱能量', W / 2, H / 2);
    }
    const yMax = niceCeil(sMax * 1.15);

    // 对数横轴映射
    const logMin = Math.log10(F_MIN);
    const logMax = Math.log10(F_MAX);
    const xOf = (f: number): number => {
      const lf = Math.min(logMax, Math.max(logMin, Math.log10(Math.max(f, 1e-6))));
      return PAD.left + ((lf - logMin) / (logMax - logMin)) * plotW;
    };
    const yOf = (s: number): number =>
      PAD.top + plotH * (1 - Math.min(1, Math.max(0, s / yMax)));

    ctx.font = FONT;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR.grid;
    ctx.fillStyle = COLOR.text;

    // ---- 网格与轴 ----
    // 纵向（频率）刻度：0.02 0.05 0.1 0.2 0.5 1 2
    const fTicks = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of fTicks) {
      const x = xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, H - PAD.bottom);
      ctx.stroke();
      ctx.fillText(f >= 1 ? f.toFixed(0) : f.toFixed(2), x, H - PAD.bottom + 5);
    }

    // 横向（谱密度）刻度 4 分度
    const sStep = yMax / 4;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const s = sStep * i;
      const y = yOf(s);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.fillText(formatFixed(s, 2), PAD.left - 6, y);
    }

    // 轴名
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('S/m²·s', 4, PAD.top - 12);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('f/Hz（对数）', W - PAD.right, H - PAD.bottom + 5);

    // ---- 理论谱曲线 ----
    if (data.theory.length >= 2) {
      ctx.strokeStyle = COLOR.theory;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of data.theory) {
        const x = xOf(p.f);
        const y = yOf(p.s);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // ---- 分量能量 stem ----
    ctx.strokeStyle = COLOR.stem;
    ctx.lineWidth = 2;
    for (const p of data.stems) {
      const x = xOf(p.f);
      const y = yOf(p.s);
      ctx.beginPath();
      ctx.moveTo(x, H - PAD.bottom);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 3, y);
      ctx.lineTo(x + 3, y);
      ctx.stroke();
    }

    // ---- 谱峰标注：fp 竖虚线 + fp/Tp 文本 ----
    if (data.peakFrequency !== null && data.peakFrequency > F_MIN) {
      const x = xOf(data.peakFrequency);
      ctx.save();
      ctx.strokeStyle = COLOR.marker;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top + 2);
      ctx.lineTo(x, H - PAD.bottom);
      ctx.stroke();
      ctx.restore();
      const label =
        data.peakPeriod !== null
          ? `fp=${data.peakFrequency.toFixed(2)}Hz（Tp=${formatFixed(data.peakPeriod, 1)}s）`
          : `fp=${data.peakFrequency.toFixed(2)}Hz`;
      ctx.fillStyle = COLOR.marker;
      ctx.textAlign = x > W * 0.7 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + (x > W * 0.7 ? -5 : 5), PAD.top);
    }

    // 图例
    ctx.font = FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR.theory;
    ctx.fillText('— 理论谱 S(f)', PAD.left + 6, PAD.top - 14);
    ctx.fillStyle = COLOR.stem;
    ctx.fillText('▎ 采样分量能量', PAD.left + 82, PAD.top - 14);
  }

  return { el, draw, resize };
}
