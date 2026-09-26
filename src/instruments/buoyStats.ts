/**
 * 观测浮标统计（纯逻辑）—— SPEC §7.4 / 实验三"海洋观测浮标"升级：
 * 对浮标自身 η(t) 记录（20Hz 均匀采样）做真实海洋观测统计：
 *   - Hs 谱估计：Hs = 4σ（σ 为 η 标准差，等价 4√m0）；
 *   - H1/3：上跨零分波后前 1/3 大波的平均波高；
 *   - Tz：相邻上跨零平均过零周期；
 *   - Tp 谱峰估计：Hann 窗周期图峰值 + 抛物线插值（自写 radix-2 FFT，≤1024 点）。
 * 不依赖 DOM / store / clock。
 */

export interface BuoyEtaSample {
  t: number;
  eta: number;
}

export interface BuoyStats {
  sampleCount: number;
  meanEta: number;
  stdEta: number;
  /** 谱估计有效波高 Hs = 4σ（m） */
  hs4Sigma: number;
  /** 前 1/3 大波平均波高 H1/3（m）；无法分波时 null */
  h13: number | null;
  /** 上跨零分波得到的波个数 */
  waveCount: number;
  /** 平均过零周期 Tz（s）；波数 < 2 时 null */
  zeroUpCrossPeriod: number | null;
  /** 周期图峰频率估计 f̂p（Hz）；样本不足时 null */
  spectralPeakFrequency: number | null;
  /** 周期图峰周期估计 T̂p = 1/f̂p（s） */
  spectralPeakPeriod: number | null;
}

export function emptyBuoyStats(): BuoyStats {
  return {
    sampleCount: 0,
    meanEta: 0,
    stdEta: 0,
    hs4Sigma: 0,
    h13: null,
    waveCount: 0,
    zeroUpCrossPeriod: null,
    spectralPeakFrequency: null,
    spectralPeakPeriod: null,
  };
}

const MIN_SAMPLES = 16;
const FFT_MAX_POINTS = 1024;
const FFT_MIN_POINTS = 64;
/** 谱峰搜索频带（Hz）：避开直流与接近 Nyquist 的尾部 */
const SEARCH_F_MIN = 0.03;

// ============================================================
// 基础统计
// ============================================================

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / values.length);
  return { mean, std };
}

interface ZeroCrossWave {
  /** 波高 = 峰谷差（m） */
  height: number;
  /** 波周期 = 相邻上跨零间隔（s） */
  period: number;
}

/** 上跨零分波：返回每个波（相邻上跨零之间）的波高与周期 */
export function zeroUpCrossWaves(samples: readonly BuoyEtaSample[]): ZeroCrossWave[] {
  const waves: ZeroCrossWave[] = [];
  const crossings: number[] = []; // 插值后的上跨零时刻
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (!a || !b) continue;
    if (a.eta <= 0 && b.eta > 0) {
      const frac = (0 - a.eta) / (b.eta - a.eta);
      crossings.push(a.t + frac * (b.t - a.t));
    }
  }
  for (let w = 0; w < crossings.length - 1; w++) {
    const t0 = crossings[w];
    const t1 = crossings[w + 1];
    if (t0 === undefined || t1 === undefined) continue;
    let max = -Infinity;
    let min = Infinity;
    for (const s of samples) {
      if (s.t < t0 || s.t > t1) continue;
      if (s.eta > max) max = s.eta;
      if (s.eta < min) min = s.eta;
    }
    if (max > -Infinity && min < Infinity) {
      waves.push({ height: max - min, period: t1 - t0 });
    }
  }
  return waves;
}

// ============================================================
// radix-2 FFT 与周期图
// ============================================================

/** 就地 radix-2 FFT（迭代蝶形）；长度必须为 2 的幂 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // 位反转重排
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  // 蝶形
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const iEven = start + k;
        const iOdd = iEven + len / 2;
        const uRe = re[iEven] as number;
        const uIm = im[iEven] as number;
        const vRe = (re[iOdd] as number) * curRe - (im[iOdd] as number) * curIm;
        const vIm = (re[iOdd] as number) * curIm + (im[iOdd] as number) * curRe;
        re[iEven] = uRe + vRe;
        im[iEven] = uIm + vIm;
        re[iOdd] = uRe - vRe;
        im[iOdd] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** 最近的 ≤ n 的 2 的幂（≥ minPower） */
function largestPow2AtMost(n: number): number {
  let p = FFT_MIN_POINTS;
  while (p * 2 <= n && p < FFT_MAX_POINTS) p *= 2;
  return Math.min(p, FFT_MAX_POINTS);
}

/**
 * 周期图谱峰频率估计：
 * 取末尾 N=2^k 个样本 → 去均值 → Hann 窗 → FFT → |X|² → 在
 * [SEARCH_F_MIN, 0.9·Nyquist] 内找峰 → 抛物线插值细化。
 */
export function spectralPeakEstimate(
  samples: readonly BuoyEtaSample[],
  sampleRateHz: number,
): { frequency: number | null; period: number | null } {
  if (samples.length < FFT_MIN_POINTS) return { frequency: null, period: null };
  const n = largestPow2AtMost(samples.length);
  const tail = samples.slice(samples.length - n);
  const { mean } = meanStd(tail.map((s) => s.eta));

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = tail[i];
    const value = s ? s.eta - mean : 0;
    // Hann 窗
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = value * w;
  }
  fftInPlace(re, im);

  const kMax = Math.floor(n / 2) - 1;
  const fLow = Math.max(1, Math.ceil((SEARCH_F_MIN * n) / sampleRateHz));
  const fHigh = Math.min(kMax, Math.floor((0.9 * (sampleRateHz / 2) * n) / sampleRateHz));
  let bestK = -1;
  let bestP = -Infinity;
  for (let k = fLow; k <= fHigh; k++) {
    const p = (re[k] as number) ** 2 + (im[k] as number) ** 2;
    if (p > bestP) {
      bestP = p;
      bestK = k;
    }
  }
  if (bestK < 1) return { frequency: null, period: null };

  // 抛物线插值（对数谱更稳，此处功率谱已足够）
  const pPrev = Math.log(
    Math.max(1e-300, (re[bestK - 1] as number) ** 2 + (im[bestK - 1] as number) ** 2),
  );
  const pCur = Math.log(
    Math.max(1e-300, (re[bestK] as number) ** 2 + (im[bestK] as number) ** 2),
  );
  const pNext = Math.log(
    Math.max(1e-300, (re[bestK + 1] as number) ** 2 + (im[bestK + 1] as number) ** 2),
  );
  const denom = pPrev - 2 * pCur + pNext;
  const delta = Math.abs(denom) > 1e-15 ? (0.5 * (pPrev - pNext)) / denom : 0;
  const frequency = ((bestK + Math.max(-0.5, Math.min(0.5, delta))) * sampleRateHz) / n;
  if (!(frequency > 0) || !Number.isFinite(frequency)) {
    return { frequency: null, period: null };
  }
  return { frequency, period: 1 / frequency };
}

// ============================================================
// 汇总
// ============================================================

/** 对浮标 η(t) 缓冲做完整统计（sampleRateHz 为采样率，浮标端为 20Hz） */
export function computeBuoyStats(
  samples: readonly BuoyEtaSample[],
  sampleRateHz: number,
): BuoyStats {
  if (samples.length < MIN_SAMPLES) return emptyBuoyStats();
  const etas = samples.map((s) => s.eta);
  const { mean, std } = meanStd(etas);

  const waves = zeroUpCrossWaves(samples);
  let h13: number | null = null;
  let tz: number | null = null;
  if (waves.length >= 1) {
    const sorted = [...waves.map((w) => w.height)].sort((a, b) => b - a);
    const topCount = Math.max(1, Math.floor(sorted.length / 3));
    let sum = 0;
    for (let i = 0; i < topCount; i++) sum += sorted[i] as number;
    h13 = sum / topCount;
  }
  if (waves.length >= 2) {
    // 平均过零周期 = 全部波周期均值（对不规则海况比总跨距更稳健）
    let sum = 0;
    for (const w of waves) sum += w.period;
    tz = sum / waves.length;
  }

  const peak = spectralPeakEstimate(samples, sampleRateHz);

  return {
    sampleCount: samples.length,
    meanEta: mean,
    stdEta: std,
    hs4Sigma: 4 * std,
    h13,
    waveCount: waves.length,
    zeroUpCrossPeriod: tz,
    spectralPeakFrequency: peak.frequency,
    spectralPeakPeriod: peak.period,
  };
}
